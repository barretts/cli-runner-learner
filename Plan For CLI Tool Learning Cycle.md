# **Architecting Autonomous Agentic Loops for Command-Line Interface Interaction and Learning**

The paradigm of large language models (LLMs) has decisively shifted from conversational interfaces to autonomous execution environments. Rather than functioning as static oracles that generate text in a single inference pass, advanced AI systems now operate as dynamic agents capable of perceiving, reasoning, and acting within complex software ecosystems. One of the most potent, yet demanding, environments for these agents is the Command-Line Interface (CLI). Operating a CLI represents a unique challenge for an autonomous system: it requires the agent to read unstructured terminal output, manage interactive prompts, deduce the underlying schemas of unfamiliar tools, verify the side effects of its actions, and recursively learn from its operational history.

Constructing a "forced learning cycle"—an autonomous loop designed to explore, master, and utilize arbitrary CLI tools—demands a sophisticated orchestration architecture. Such a system must combine strict programmatic terminal bindings with dynamic prompt generation, structured memory retrieval, deterministic state assessment, and rigorous security sandboxing. This report provides an exhaustive architectural blueprint for developing a recursive learning loop capable of interacting with novel CLI environments, synthesizing knowledge into persistent memory, and executing complex objectives autonomously. Crucially, it translates these theoretical architectures into a concrete implementation plan tailored for initializing a bounded learning cycle targeting specific local directories and tools.

## **Phase I: Architectural Foundations of the Agent Loop**

The foundational difference between a standard LLM chatbot and an autonomous agent lies in a specific software engineering pattern: the agent loop. Every major artificial intelligence developer has converged on a recursive execution cycle as the core engine for autonomous behavior.1 This loop enables the system to maintain persistence across multiple actions, adapting its strategy based on real-time environmental feedback.

### **The Five-Stage Execution Cycle**

The continuous operation of an agent within a CLI environment is governed by a five-stage iterative cycle that loops until a terminal success condition is met or a budget constraint is exhausted.1

1. **Perceive:** The system ingests the current state of the environment. In a CLI context, this involves capturing the standard output (stdout) and standard error (stderr) streams from a previously executed command, reading the contents of a local file, or evaluating system error codes.1  
2. **Reason:** The underlying LLM processes the perceived data alongside its historical context window to deduce the current operational state. It identifies errors, analyzes system feedback, and determines the logical next step.1  
3. **Plan:** For multi-step objectives, the agent decomposes the primary goal into a sequence of subtasks. This may manifest as a formal Directed Acyclic Graph (DAG) or a simple sequential list of operations maintained in the agent's scratchpad.1  
4. **Act:** The orchestrator executes the LLM's chosen action. This translates to invoking a specific Python function, executing a shell script, or interacting with a Model Context Protocol (MCP) tool.1  
5. **Observe:** The system captures the direct output of the action, evaluating whether the localized goal was achieved before looping back to the perception phase.1

This framework is heavily influenced by the ReAct (Reasoning and Acting) paradigm, which explicitly interleaves reasoning traces with tool actions. By forcing the model to generate a "thought" before taking an "action," the system is equipped to self-correct based on the subsequent "observation".1 However, as tasks scale in complexity, pure ReAct loops can become inefficient. The Plan-and-Execute pattern separates these concerns, utilizing a primary planner model to generate an execution graph, while smaller, faster worker models execute the individual CLI commands.1

### **Complexity Spectrums and Coordination Models**

Implementing agent loops in production requires engineering against two primary constraints: cost and observability.1 Agentic loops consume significantly more computational resources than zero-shot inference. Because the context window grows with every iteration of the loop—incorporating previous thoughts, commands, and terminal outputs—an autonomous agent can consume up to four times as many tokens as a standard chat interaction, and up to fifteen times as many in multi-agent configurations.1

To optimize these costs and manage system reliability, architects must select the appropriate level of orchestration complexity based on the specific operational requirement.

| Orchestration Level | Architectural Description | Ideal Use Case & Constraints |
| :---- | :---- | :---- |
| **Direct Model Call** | A single inference pass utilizing zero-shot or few-shot prompting without an internal while loop. | Deterministic formatting or single-step data extraction. Offers minimal latency but zero autonomous recovery capabilities.3 |
| **Single Agent with Tools** | One primary model executing a continuous ReAct loop, selecting from a defined array of programmatic tools. | The standard default for bounded CLI exploration. Easier to observe and debug, but requires strict iteration limits to prevent infinite execution loops.3 |
| **Multi-Agent Orchestration** | Multiple specialized models coordinate via a centralized router, a hierarchical delegation structure, or a decentralized swarm protocol. | Required for complex, multi-domain environments (e.g., executing code, analyzing financial data, and deploying infrastructure simultaneously). Introduces high latency and architectural overhead.1 |

In advanced implementations like Claude Code, the system dynamically manages these complexities through sub-agent spawning. A primary agent orchestrating a complex refactoring task may spawn a specialized "Explore" sub-agent—a lightweight, read-only model tasked strictly with parallelizing file searches and gathering context, thereby preserving the primary agent's context window and reducing overall token expenditure.4 Furthermore, implementing budgeted autonomy is critical; systems must enforce strict quotas on tokens, reasoning time, and consecutive loop iterations to mitigate the risk of delegation deadlocks or infinite failure loops.1

## **Phase II: Programmatic Terminal Interfacing and I/O Control**

To physically interface an LLM with a command-line environment, the orchestration layer must translate the model's textual intent into an executable system process. Naive implementations rely on Python's subprocess or os.system() modules. While these are sufficient for executing discrete, non-blocking commands that return immediate output (e.g., ls \-la), they fail catastrophically when confronted with interactive CLI utilities.6

### **Bypassing Limitations with Pseudo-Teletypes and pexpect**

When a CLI tool requests real-time user input—such as an SSH password prompt, a confirmation dialogue requiring y/n, or a configuration wizard—the execution stream blocks, and the standard subprocess.PIPE hangs indefinitely because it cannot interact dynamically with the running process.7 Furthermore, many applications alter their behavior when they detect that their standard input and output streams are not connected to a true terminal, stripping vital ANSI color codes or bypassing stdin entirely to read directly from the TTY device for security reasons.8

To build a resilient agent capable of learning and utilizing arbitrary tools, the system must utilize pseudo-teletype (pty) interfaces. The pexpect library is the industry standard for this requirement in Python.6 Rather than piping standard input and output blindly, pexpect creates a virtual terminal, allowing the agent to spawn a child application and control it programmatically, exactly as a human operator would.6

An AI agent integrated with pexpect operates via a structured expectation protocol:

1. **Spawn:** The agent initializes the command within the pty (e.g., child \= pexpect.spawn('ssh user@target')).7  
2. **Expect:** The system waits for a specific regular expression pattern in the terminal's output buffer (e.g., child.expect('password:')).6  
3. **Capture:** The library exposes child.before and child.after attributes, capturing the text generated leading up to the matched prompt, which is then fed back to the LLM's context window for analysis.9  
4. **Send:** The agent generates the appropriate response and submits it to the process (e.g., child.sendline('my\_secret\_password')).7

By utilizing pexpect within a recursive loop, an LLM can traverse multi-step interactive configurations autonomously. If the agent encounters an unexpected prompt (resulting in a TIMEOUT or EOF exception), the error trace and the contents of the child.before buffer are returned to the agent, allowing it to re-evaluate the terminal state and generate a corrective action.10 Experimental libraries like expectllm build upon this paradigm by treating LLM conversations like classic expect scripts, combining prompt sending, pattern matching, and execution branching natively.13

### **Extending Tool Mastery with Composable Automation Libraries**

Beyond pexpect, an agent's capability to interact with complex local environments is amplified by integrating adjacent automation libraries.7

* **watchfiles**: An agent can establish a listener to monitor specific directories for changes, allowing it to react to file dumps or build artifacts asynchronously without continuous polling loops.7  
* **plumbum**: This library enables agents to construct composable shell commands in a structured Pythonic format (e.g., piping ls output to grep programmatically), reducing the reliance on raw string manipulation and enhancing the safety of command execution.7

### **Mitigating Autonomous Shell Injection**

Granting an LLM direct control over terminal execution introduces a severe vulnerability: Autonomous Shell Injection.14 When an LLM hallucinates parameters or misinterprets a command structure, it may inadvertently generate destructive syntax. If an orchestration layer passes a string directly to a shell environment using shell=True, it inherits all the risks of traditional command injection. For example, if an agent is tasked with checking a service status and generates the string service\_name ; rm \-rf / \#, the shell will execute the destructive payload alongside the primary command.14

To secure the execution layer, all input generated by the LLM must be rigorously sanitized before interfacing with the operating system. This is achieved by utilizing application-level sanitization routines that strip shell metacharacters (e.g., ;&|\<\>()$\\) and by enforcing process invocation through arrays rather than raw strings.14 Utilizing execution wrappers with shell=False ensures that the arguments are passed directly to the executable as a list, completely bypassing the shell interpreter's parsing mechanisms and neutralizing injection payloads.16

## **Phase III: Implementing the Bounded Sandbox Environment**

Autonomous agents are essentially software entities granted high-level access to a computational environment.17 As these agents learn to utilize CLI tools, explore filesystems, and issue network requests, they inherently possess the capability to destroy data, exfiltrate credentials, and permanently corrupt operating systems.14 Developing a forced learning cycle without rigorous security boundaries is architectural negligence.

### **The Necessity of YOLO Mode Boundaries**

To be highly effective, an agent must operate autonomously without halting for human confirmation at every minor step—a state colloquially termed "YOLO mode".19 However, running autonomous loops directly on bare-metal hardware introduces unacceptable risks, sparking debate within the engineering community regarding the normalization of running tools like Anthropic's Computer Use directly on primary workstations.20 A hallucinating agent attempting to clear a temporary folder could easily issue an unrestricted recursive delete command.14

Therefore, guardrails must be enforced *outside* the agent's cognitive loop, at the infrastructure level.19 Agents require a "bounding box": strict, pre-defined constraints that isolate the agent's execution environment from the host machine.19

### **Layered Isolation Protocols**

Effective sandboxing requires layered isolation protocols that address filesystem access, network egress, and secret management.18

| Isolation Layer | Implementation Strategy | Purpose and Mitigation |
| :---- | :---- | :---- |
| **Filesystem Virtualization** | Utilizing Docker containers, WSL2 instances, or lightweight Linux namespaces (e.g., bubblewrap).16 macOS systems may utilize native, albeit deprecated, sandbox-exec profiles.21 | Prevents the agent from accessing sensitive host directories (e.g., \~/.ssh). Blocks write operations outside the designated active workspace, neutralizing destructive file operations.18 |
| **Network Egress Control** | Strict firewall rules enforced at the container level or via virtualized network interfaces.18 | Prevents the agent from downloading unverified binaries, exfiltrating scraped data, or establishing remote shells to malicious domains.17 |
| **Secret Isolation** | Banning the use of localized .env files within the sandbox. Utilizing encrypted, headless wallet interfaces or dynamic credential injection from secure cloud vaults (e.g., Azure Key Vault).17 | Ensures that even if the agent is compromised via an indirect prompt injection attack, it cannot access or broadcast persistent system credentials.17 |

### **Managing Approval Fatigue**

While the ultimate goal is full autonomy within a sandbox, certain high-risk operations—such as pushing code to production, modifying external infrastructure, or initiating network transactions—must still require a human-in-the-loop (HITL) approval gate.16

However, relying heavily on manual approvals introduces "approval fatigue".18 If a user is bombarded with confirmation prompts for every trivial command, they will inevitably begin authorizing actions blindly, neutralizing the security control entirely.18 Modern orchestrators optimize this by blending sandbox freedom with targeted escalations. The agent is permitted to execute freely within its virtualized container, running compilations and tests without interruption. It only halts to request explicit human confirmation when attempting an action that violates its default-deny isolation policies, such as attempting a network connection to an unknown IP or modifying an external repository.18 This preserves the speed of the learning loop while maintaining critical safety oversight.

## **Phase IV: Dynamic Tool Discovery and Schema Mapping**

For a continuous learning cycle to be effective, an agent cannot be hardcoded to understand a static set of tools. Instead, it must dynamically discover the capabilities of its environment, learn the syntax of novel CLIs, and adapt its internal schemas to utilize them accurately.

### **Parsing Unstructured Help Documentation**

When dropped into an unfamiliar directory containing custom scripts or third-party binaries, the agent's first action is exploratory. By executing \<tool\> \--help or querying man pages, the agent extracts the raw, unstructured documentation for the utility.16 However, raw terminal output is highly variable and prone to token bloat. To interface reliably with these tools, the unstructured text must be converted into strict, machine-readable definitions.

Advanced orchestration systems utilize intermediate Python logic to automate this translation. Libraries such as argparse can be leveraged programmatically to parse command-line structures, which can then be fed into JSON Schema generators like genson or jsonschema.29 This pipeline allows the system to execute a dry run of a target script, capture its argument requirements, and instantly generate a strict JSON Schema detailing every required flag, expected data type, and default value.28 The agent is then provided with this structured schema rather than the raw help text, dramatically improving its ability to generate syntactically valid commands on its first attempt. This process mirrors human documentation parsing but accelerates it through deterministic schema mapping.33

### **The Model Context Protocol (MCP) and Ecosystem Discovery**

While dynamic parsing is highly effective for custom scripts, the industry is rapidly standardizing around the Model Context Protocol (MCP) to solve the problem of tool discovery and integration.1 MCP functions as an open standard that allows command-line tools, local databases, and external APIs to expose their capabilities to AI agents through a uniform, version-controlled schema.36

Without MCP, invoking CLIs autonomously is brittle; a minor update that deprecates a flag or alters an output format will silently break an agent's established workflow. MCP mitigates this by allowing tools to describe themselves dynamically at runtime. An MCP server provides the agent with discrete JSON structures defining the tool's name, description, and strict inputSchema.36

When an agent utilizes an MCP-enabled tool, the system guarantees that the parameters generated by the LLM match the exact specifications required by the underlying utility before execution.36 This architectural pattern not only reduces execution errors but also minimizes the context window overhead. By relying on an MCP server to manage the intricate details of tool invocation and data formatting, agents can reduce their context bloat by up to 98.7%, allowing for significantly longer and more complex autonomous loops.1

Frameworks like FastMCP simplify the deployment of these interfaces, while centralized hubs such as CLI-Anything, Google Workspace CLI, and AutoCLI provide vast ecosystems of pre-mapped CLI tools that an agent can autonomously pull into its active context.36

## **Phase V: Handling Non-Determinism and Structured Output**

The fundamental friction in designing a reliable learning loop is managing the inherent stochasticity of large language models.41 While CLIs are hyper-deterministic—requiring exact syntax, strict flags, and precise parameter ordering—LLMs operate probabilistically.41 Generating the same prompt multiple times may yield completely different command structures, undermining the stability of the learning cycle.41

### **Temperature Tuning and Structured Generation**

To force an LLM to interface reliably with a deterministic environment, engineers must manipulate the model's generation parameters and enforce strict structural decoding constraints.43 The most immediate mitigation is adjusting the model's sampling parameters. By setting the temperature parameter to a value approaching zero (![][image1]), the model's unpredictability is drastically reduced, forcing it to consistently select the highest-probability tokens.41 While high temperatures are beneficial for creative writing, minimal temperatures are mandatory for generating reliable shell syntax.41

Furthermore, raw text generation is frequently insufficient for complex tool orchestration. When an agent determines the parameters for a tool, the output must be generated using strict Structured Output modes.43 By combining prompt engineering with schema-validation frameworks like Pydantic or Zod, the LLM is constrained to output data that perfectly maps to the predefined JSON schema of the target CLI tool.43

Advanced parsing frameworks like BAML utilize Rust-based error-tolerant parsers that can ingest malformed JSON (e.g., recovering from missing quotes or trailing commas) and coerce it into valid data structures before it reaches the execution layer.46 At the deepest level, advanced decoding algorithms like DOMINO operate directly at the token level, aggressively pruning the probability distribution of any sub-word token that would violate the required structural grammar, guaranteeing that the orchestration layer receives valid, parseable syntax on every iteration.43

## **Phase VI: State Assessment and Verifiable Feedback**

In human-driven CLI interaction, a user intuitively verifies the results of their commands. If they compile a binary, they run ls to ensure the file exists. If they modify a database, they execute a SELECT statement to verify the transaction. Autonomous agents, however, are prone to "blind execution"—assuming a task is complete simply because a tool returned a zero exit code. Designing a robust learning loop requires mechanisms for deterministic state assessment.47

### **Beyond Binary Exit Codes**

Relying solely on process exit codes is a critical failure point in agentic design.47 A shell command may return an exit code of 0 (success) while failing to achieve the desired semantic outcome, or it may return an error trace while still committing partial, undocumented changes to the filesystem. If an agent cannot measure the quality and reality of its actions, it cannot be trusted to operate autonomously.47 Negative side effects (NSEs)—undesirable, unmodeled effects of agent actions on the environment—are a significant risk when an agent operates with incomplete models of unfamiliar CLI tools.49

To combat this, the loop must assess explicit state rather than transient terminal output.47 After a command is executed, the agent's observation phase must include automated validation sequences. This can manifest as discrete verification loops: if the agent writes a block of code, the loop must automatically invoke a test suite or linter, halting further action until those secondary validation checks pass, thereby preventing an agent from stacking error upon error.48

### **Filesystem Snapshots and Differential Calculus**

To truly understand the side effects of an action—especially when learning how a novel CLI tool operates—the orchestration layer must leverage system-level state tracking. This allows the agent to observe exactly what files were modified, created, or deleted by a command.49

1. **Version Control Diagnostics (Git):** The most accessible method for tracking localized side effects is utilizing Git differentials.50 Before the agent executes an unknown command, the orchestrator ensures the working directory is clean. After execution, the agent relies on git status and git diff to view the precise textual changes made to the codebase. The LLM parses these differentials to confirm that the CLI tool modified the intended targets without causing collateral damage to adjacent files.50  
2. **Block-Level Filesystem Snapshots:** For comprehensive verification that extends beyond source code (e.g., tracking database mutations, log generation, or binary compilation), the system can rely on advanced filesystems like ZFS or BTRFS.54 These filesystems allow for instantaneous, zero-cost block-level snapshots. By snapshotting a ZFS dataset prior to a complex execution sequence, the orchestrator can monitor all absolute file events across the entire partition.54 If the agent triggers catastrophic negative side effects, the system can instantly roll back the dataset to its pristine state, ensuring that the learning cycle remains non-destructive.49  
3. **Process-Reward Functionals:** In advanced coding environments, verification is handled via the Language Server Protocol (LSP). Rather than relying on the LLM's textual interpretation of its changes, the orchestrator queries an LSP server to extract verifiable facts—definitions, references, type diagnostics, and safe edits.56 These deterministic facts are synthesized into a "process reward" that supervises the agent's intermediate steps, making it suitable for process supervision and counterfactual analysis.56

## **Phase VII: The Forced Learning Cycle (Memory, Skills, and RLVR)**

The hallmark of a "forced learning cycle" is not just the ability to execute a command, but the ability to persist the knowledge gained from that execution. An agent that forgets the intricacies of a novel CLI tool upon session termination provides little compounding value. The architecture must support a framework where the system learns, adapts, and improves over time.

### **The Phases of Autonomous Skill Acquisition**

The learning loop architecture mirrors traditional experiential learning paradigms, synthesized into an automated pipeline 57:

1. **Observe and Understand:** The agent inspects the environment, reads documentation, analyzes code structures, or parses \--help text to establish an initial mental model of the system.57  
2. **Experiment and Try:** The agent formulates a hypothesis and executes a command. In unfamiliar environments, this often results in a syntax error or a failed execution.57 The system captures the stack trace and stdout, feeding it back into the reasoning engine to refine the command syntax.15  
3. **Recall and Apply:** Once a successful command structure is discovered, the agent must commit this pattern to memory. When a similar task is requested in the future, the agent recalls the learned syntax rather than re-running the exploratory phase.57

### **Implementing Agentic Memory and Skill Registries**

To facilitate the "Recall and Apply" phase, orchestration frameworks utilize tiered memory structures.26

* **Core Memory (In-Context):** The system prompt, which dictates the agent's immediate persona and operational constraints. This is updated dynamically but is strictly limited by the LLM's maximum token capacity.59  
* **Archival Memory (Vector Stores):** Long-term storage utilizing vector databases (e.g., ChromaDB) and semantic search. Historical tool usage patterns, successful command sequences, and contextual summaries of past sessions are embedded and retrieved via similarity searches when the agent encounters analogous tasks.26  
* **Skill Learning and Generation:** Advanced frameworks, such as Letta Code and the Hermes Agent ecosystem, implement dynamic skill learning.59 Rather than relying solely on semantic search, these agents autonomously generate executable "skills" or "handbooks" after successfully completing a complex task. If an agent struggles to format a specific database query using a custom CLI, but eventually succeeds through iterative trial and error, it writes a permanent reference file documenting the exact syntax and edge cases.59 In future sessions, the agent loads this generated skill into its core memory, allowing it to bypass the experimentation phase entirely. This mechanism ensures that the agent's performance continuously improves across sessions, rather than degrading due to context fragmentation.4

### **Synthetic Data and Reinforcement Learning with Verifiable Rewards (RLVR)**

While runtime in-context learning is valuable, truly robust CLI mastery requires offline fine-tuning of the foundational LLM. Specialized agent models can be trained to operate distinct CLIs without any prior knowledge through Reinforcement Learning with Verifiable Rewards (RLVR).16

Because specialized enterprise CLIs lack the massive public datasets required for traditional pre-training, engineers utilize Synthetic Data Generation (SDG) to programmatically generate thousands of high-quality interaction trajectories from a handful of seed examples.16 This synthetic data is then used to fine-tune the model using Group Relative Policy Optimization (GRPO), a memory-efficient alternative to traditional Proximal Policy Optimization (PPO) that evaluates relative advantages within a group of generated responses.16

In the RLVR paradigm, the agent is placed in an isolated sandbox (like NeMo Gym) and tasked with executing CLI goals.16 Because terminal environments are highly deterministic, the system does not require a secondary "critic" model or human evaluator to score the agent's performance. Instead, the reward function is mathematically tied to the environment: a syntactically valid command that yields the correct execution state results in a strict \+1 reward, while an invalid command or syntax error yields a \-1 penalty.16 Through this rapid, automated reinforcement cycle, the underlying model fundamentally alters its weight distribution to favor the correct operational syntax of the target CLI, producing a highly specialized, highly accurate agentic engine.16

## **Phase VIII: Fuzzing and Autonomous Exploration Strategies**

To efficiently discover the capabilities of unknown CLI tools, agent learning loops can borrow heavily from cybersecurity practices, specifically automated fuzzing.63 In software security, fuzzers generate massive volumes of pseudo-random inputs to test a program's boundaries. When adapted for AI agents, this technique becomes a structured mechanism for tool exploration.

Systems like LLM-Fuzzer or PILOT utilize LLMs to autonomously orchestrate command-line tools for input file generation, iteratively refining their understanding based on coverage feedback.63 Instead of waiting for a user prompt, the learning loop proactively executes a target tool with varying arguments, flag combinations, and input formats. By observing which permutations return syntax errors and which execute successfully, the agent dynamically maps the operational boundary of the CLI tool.15 This autonomous exploration generates the raw experience necessary to populate the agent's skill registries and vector memory, turning an unknown binary into a fully mapped asset.66

## **Phase IX: Concrete Implementation Plan for the Local Learning Cycle**

Synthesizing the preceding architectural requirements, the following is a concrete, multi-step implementation plan designed to establish a forced learning cycle targeting a specific local directory (e.g., /Users/ephem/lcode/3pp-fix-database/temp). This blueprint assumes the integration of the Claude API as the primary reasoning engine and pexpect for terminal control.

### **Step 1: Environment Initialization and Sandboxing**

Before any agent loop is instantiated, the execution environment must be secured to prevent negative side effects from escaping the target directory.

1. **Isolate the Workspace:** The execution script must explicitly restrict the working directory to /Users/ephem/lcode/3pp-fix-database/temp. Any command generated by the LLM attempting to traverse outside this directory (e.g., cd../../../) must be intercepted and rejected by the orchestration logic prior to execution.  
2. **Containerization (Recommended):** To ensure maximum safety, mount the temp directory as a volume inside a lightweight Docker container. The python script driving the learning loop will execute within this container, establishing network egress controls and preventing access to the host machine's broader filesystem or SSH keys.  
3. **State Tracking Initialization:** Initialize a Git repository within the temp directory (git init). Commit the initial state of the directory. This will serve as the baseline for differential calculus and state verification after every command execution.

### **Step 2: The Orchestrator Configuration**

The orchestrator serves as the bridge between the Claude API and the pexpect terminal instance.

1. **System Prompts and Core Memory:** Configure Claude's system prompt to define its operational constraints. It must be instructed that it is operating within a continuous CLI loop, that it will be interacting with tools that may require multi-step prompts, and that it must verify all side effects.  
2. **Tool Definitions:** Expose a minimal set of Python functions to Claude via the Anthropic Tool Use API. The core tool will be an execute\_cli\_command function that acts as a wrapper around pexpect.  
3. **Memory Store Setup:** Initialize a local JSON file or a lightweight SQLite database (e.g., skills.db) to serve as the archival memory for persistent skill storage.

### **Step 3: The pexpect Execution State Machine**

This is the core of the forced learning cycle, wrapping the standard subprocess execution in a state machine capable of handling interactivity.

1. **Spawning the Process:** When Claude decides to execute a tool, the orchestrator initializes the command: child \= pexpect.spawn(command, cwd="/Users/ephem/lcode/3pp-fix-database/temp").  
2. **The Expectation Loop:** Instead of waiting for the process to exit, the orchestrator loops over a set of expected patterns:  
   * child.expect('\])  
3. **Handling Interactivity:** If pexpect matches an interactive prompt (like yes/no or a custom application prompt), the orchestrator pauses execution. It sends the contents of child.before (the context leading up to the prompt) and the matched prompt itself back to Claude as a new user message.  
4. **Agent Response:** Claude reasons about the prompt and generates a response. The orchestrator relays this back to the terminal via child.sendline(response), and the expectation loop continues until pexpect.EOF is reached, signifying the tool has completed execution.

### **Step 4: State Verification and Differential Analysis**

Once pexpect.EOF is reached, the orchestrator does not immediately assume success.

1. **Terminal Output Review:** The final stdout and stderr are passed to Claude.  
2. **Filesystem Differential:** The orchestrator automatically runs git status and git diff within the temp directory. This output is appended to Claude's context window.  
3. **Verification Prompt:** The system forces Claude to answer: "Based on the terminal output and the Git differential, did the previous command achieve the intended goal? Are there any unintended side effects?"

### **Step 5: Skill Generation and Loop Iteration**

Based on the verification phase, the loop either iterates or persists knowledge.

1. **Failure Iteration:** If the command failed or produced unintended side effects, the orchestrator runs git reset \--hard to revert the temp directory to its pristine state. Claude is prompted with the error trace and instructed to generate a new, modified command. The loop returns to Step 3\.  
2. **Success and Skill Persistence:** If the command was successful, Claude is instructed to generate a structured "Skill Summary"—a JSON object detailing the target CLI tool, the exact syntax used, the required interactive prompts, and the verified outcome. This is appended to skills.db.  
3. **Future Execution:** In subsequent iterations of the loop, before Claude generates a new command, the orchestrator queries skills.db. If a matching skill exists, it is injected into Claude's prompt, allowing the agent to bypass the trial-and-error exploration and immediately execute the correct sequence.

## **Conclusion**

The construction of an autonomous learning loop for Command-Line Interface operations represents a sophisticated intersection of probabilistic artificial intelligence and deterministic systems engineering. By orchestrating a rigid perception-action cycle, an agent can dynamically explore and master unknown terminal environments. However, realizing this potential requires strict adherence to robust architectural paradigms.

The successful implementation of such a system demands the utilization of pseudo-teletypes (pexpect) for managing interactive prompts, rigorous input sanitization to prevent shell injection, and the adoption of modern protocols like MCP for dynamic, schema-driven tool discovery. To ensure the agent actually learns rather than endlessly guessing, the architecture must support persistent memory frameworks, skill generation, and block-level state verification via tools like Git or ZFS to measure true execution side effects. Above all, because these agents wield profound systemic power, they must be securely contained within isolated, virtualized sandboxes that limit network egress and prevent destructive capabilities. By integrating these strict programmatic guardrails, developers can deploy highly resilient autonomous agents capable of continuous, safe, and effective learning across complex, localized execution environments.

#### **Works cited**

1. What Is the AI Agent Loop? The Core Architecture Behind ..., accessed April 15, 2026, [https://blogs.oracle.com/developers/what-is-the-ai-agent-loop-the-core-architecture-behind-autonomous-ai-systems](https://blogs.oracle.com/developers/what-is-the-ai-agent-loop-the-core-architecture-behind-autonomous-ai-systems)  
2. Choose a design pattern for your agentic AI system | Cloud Architecture Center, accessed April 15, 2026, [https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system](https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system)  
3. AI Agent Orchestration Patterns \- Azure Architecture Center | Microsoft Learn, accessed April 15, 2026, [https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)  
4. Tracing Claude Code's LLM Traffic: Agentic loop, sub-agents, tool ..., accessed April 15, 2026, [https://medium.com/@georgesung/tracing-claude-codes-llm-traffic-agentic-loop-sub-agents-tool-use-prompts-7796941806f5](https://medium.com/@georgesung/tracing-claude-codes-llm-traffic-agentic-loop-sub-agents-tool-use-prompts-7796941806f5)  
5. From Prompt–Response to Goal-Directed Systems: The Evolution of Agentic AI Software Architecture \- arXiv, accessed April 15, 2026, [https://arxiv.org/html/2602.10479](https://arxiv.org/html/2602.10479)  
6. Core pexpect components \- Read the Docs, accessed April 15, 2026, [https://pexpect.readthedocs.io/en/stable/api/pexpect.html](https://pexpect.readthedocs.io/en/stable/api/pexpect.html)  
7. Python libraries that make AI agents more effective | East Agile Blog, accessed April 15, 2026, [https://www.eastagile.com/blogs/python-libraries-that-make-ai-agents-more-effective](https://www.eastagile.com/blogs/python-libraries-that-make-ai-agents-more-effective)  
8. Pexpect haters. : r/Python \- Reddit, accessed April 15, 2026, [https://www.reddit.com/r/Python/comments/qastj/pexpect\_haters/](https://www.reddit.com/r/Python/comments/qastj/pexpect_haters/)  
9. interact with command line program \- python \- Stack Overflow, accessed April 15, 2026, [https://stackoverflow.com/questions/51221465/interact-with-command-line-program](https://stackoverflow.com/questions/51221465/interact-with-command-line-program)  
10. API Overview — Pexpect 4.8 documentation \- Read the Docs, accessed April 15, 2026, [https://pexpect.readthedocs.io/en/stable/overview.html](https://pexpect.readthedocs.io/en/stable/overview.html)  
11. PyBites Module of the Week – Pexpect, accessed April 15, 2026, [https://pybit.es/articles/pexpect/](https://pybit.es/articles/pexpect/)  
12. pexpect for terminal at local computer \- Stack Overflow, accessed April 15, 2026, [https://stackoverflow.com/questions/39199451/pexpect-for-terminal-at-local-computer](https://stackoverflow.com/questions/39199451/pexpect-for-terminal-at-local-computer)  
13. expectllm: Expect-style pattern matching for LLM conversations : r/LLMDevs \- Reddit, accessed April 15, 2026, [https://www.reddit.com/r/LLMDevs/comments/1ra2h72/expectllm\_expectstyle\_pattern\_matching\_for\_llm/](https://www.reddit.com/r/LLMDevs/comments/1ra2h72/expectllm_expectstyle_pattern_matching_for_llm/)  
14. Securing CLI Based AI Agent \- Medium, accessed April 15, 2026, [https://medium.com/@visrow/securing-cli-based-ai-agent-c36429e88783](https://medium.com/@visrow/securing-cli-based-ai-agent-c36429e88783)  
15. CLI-based tool calling\*\* for autonomous agents using LLM \- GitHub, accessed April 15, 2026, [https://github.com/vishalmysore/cli-tool-calling](https://github.com/vishalmysore/cli-tool-calling)  
16. How to Train an AI Agent for Command-Line Tasks with Synthetic Data and Reinforcement Learning | NVIDIA Technical Blog, accessed April 15, 2026, [https://developer.nvidia.com/blog/how-to-train-an-ai-agent-for-command-line-tasks-with-synthetic-data-and-reinforcement-learning/](https://developer.nvidia.com/blog/how-to-train-an-ai-agent-for-command-line-tasks-with-synthetic-data-and-reinforcement-learning/)  
17. Agent Security Best Practices \- Tsuyoshi Ushio \- Medium, accessed April 15, 2026, [https://tsuyoshiushio.medium.com/agent-security-best-practices-8af6b692f145](https://tsuyoshiushio.medium.com/agent-security-best-practices-8af6b692f145)  
18. Practical Security Guidance for Sandboxing Agentic Workflows and Managing Execution Risk | NVIDIA Technical Blog, accessed April 15, 2026, [https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)  
19. Docker Sandboxes: Run Agents in YOLO Mode, Safely, accessed April 15, 2026, [https://www.docker.com/blog/docker-sandboxes-run-agents-in-yolo-mode-safely/](https://www.docker.com/blog/docker-sandboxes-run-agents-in-yolo-mode-safely/)  
20. Don't let Claude use your actual computer from the CLI : r/ClaudeAI \- Reddit, accessed April 15, 2026, [https://www.reddit.com/r/ClaudeAI/comments/1s839hp/dont\_let\_claude\_use\_your\_actual\_computer\_from\_the/](https://www.reddit.com/r/ClaudeAI/comments/1s839hp/dont_let_claude_use_your_actual_computer_from_the/)  
21. Sandboxing AI Coding Agents: What Actually Protects You? : r/ChatGPT \- Reddit, accessed April 15, 2026, [https://www.reddit.com/r/ChatGPT/comments/1qmkdkb/sandboxing\_ai\_coding\_agents\_what\_actually/](https://www.reddit.com/r/ChatGPT/comments/1qmkdkb/sandboxing_ai_coding_agents_what_actually/)  
22. Agent approvals & security – Codex | OpenAI Developers, accessed April 15, 2026, [https://developers.openai.com/codex/agent-approvals-security](https://developers.openai.com/codex/agent-approvals-security)  
23. Implementing a secure sandbox for local agents \- Cursor, accessed April 15, 2026, [https://cursor.com/blog/agent-sandboxing](https://cursor.com/blog/agent-sandboxing)  
24. I built an open source CLI tool because my AI agents needed to spend money autonomously, accessed April 15, 2026, [https://www.reddit.com/r/SideProject/comments/1show8p/i\_built\_an\_open\_source\_cli\_tool\_because\_my\_ai/](https://www.reddit.com/r/SideProject/comments/1show8p/i_built_an_open_source_cli_tool_because_my_ai/)  
25. My LLM coding workflow going into 2026 | by Addy Osmani \- Medium, accessed April 15, 2026, [https://medium.com/@addyosmani/my-llm-coding-workflow-going-into-2026-52fe1681325e](https://medium.com/@addyosmani/my-llm-coding-workflow-going-into-2026-52fe1681325e)  
26. Deep Agents CLI \- Docs by LangChain, accessed April 15, 2026, [https://docs.langchain.com/oss/python/deepagents/cli/overview](https://docs.langchain.com/oss/python/deepagents/cli/overview)  
27. LOWE \- Recursion, accessed April 15, 2026, [https://www.recursion.com/lowe](https://www.recursion.com/lowe)  
28. Building My Own CLI Tool: A Better Way to Share Code with LLMs \- DEV Community, accessed April 15, 2026, [https://dev.to/jongwan93/building-my-own-cli-tool-a-better-way-to-share-code-with-llms-1708](https://dev.to/jongwan93/building-my-own-cli-tool-a-better-way-to-share-code-with-llms-1708)  
29. GitHub \- python-jsonschema/jsonschema: An implementation of the JSON Schema specification for Python, accessed April 15, 2026, [https://github.com/python-jsonschema/jsonschema](https://github.com/python-jsonschema/jsonschema)  
30. genson \- PyPI, accessed April 15, 2026, [https://pypi.org/project/genson/](https://pypi.org/project/genson/)  
31. Generate json schema from argparse CLI \- python \- Stack Overflow, accessed April 15, 2026, [https://stackoverflow.com/questions/72718138/generate-json-schema-from-argparse-cli](https://stackoverflow.com/questions/72718138/generate-json-schema-from-argparse-cli)  
32. JSON Schema Generator Python \- Stack Overflow, accessed April 15, 2026, [https://stackoverflow.com/questions/56043331/json-schema-generator-python](https://stackoverflow.com/questions/56043331/json-schema-generator-python)  
33. gdoermann/llmdocgen: Automatic documentation using LLMs \- GitHub, accessed April 15, 2026, [https://github.com/gdoermann/llmdocgen](https://github.com/gdoermann/llmdocgen)  
34. Free and Customizable Code Documentation with LLMs: A Fine-Tuning Approach \- arXiv, accessed April 15, 2026, [https://arxiv.org/html/2412.00726v1](https://arxiv.org/html/2412.00726v1)  
35. Create a Chatbot that Generates CLI Commands from Text Using Online Documentation | by Amar Abane | Medium, accessed April 15, 2026, [https://medium.com/@amar.abane.phd/create-a-chatbot-that-generates-cli-commands-from-text-using-online-documentation-fa86b7af2f4d](https://medium.com/@amar.abane.phd/create-a-chatbot-that-generates-cli-commands-from-text-using-online-documentation-fa86b7af2f4d)  
36. Keep the Terminal Relevant: Patterns for AI Agent Driven CLIs \- InfoQ, accessed April 15, 2026, [https://www.infoq.com/articles/ai-agent-cli/](https://www.infoq.com/articles/ai-agent-cli/)  
37. Code execution with MCP: building more efficient AI agents \- Anthropic, accessed April 15, 2026, [https://www.anthropic.com/engineering/code-execution-with-mcp](https://www.anthropic.com/engineering/code-execution-with-mcp)  
38. GitHub \- googleworkspace/cli: Google Workspace CLI — one command-line tool for Drive, Gmail, Calendar, Sheets, Docs, Chat, Admin, and more. Dynamically built from Google Discovery Service. Includes AI agent skills., accessed April 15, 2026, [https://github.com/googleworkspace/cli](https://github.com/googleworkspace/cli)  
39. CLI-Anything: Making ALL Software Agent-Native \- GitHub, accessed April 15, 2026, [https://github.com/HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything)  
40. Fetch information from any website with a single command. Covers Twitter/X, Reddit, YouTube, HackerNews, Bilibili, Zhihu, Xiaohongshu, and 55+ sites, with support for controlling Electron desktop apps, integrating local CLI tools (gh, docker, kubectl), now powered by AutoCLI.ai . · GitHub, accessed April 15, 2026, [https://github.com/nashsu/AutoCLI](https://github.com/nashsu/AutoCLI)  
41. Optimizing Non-Deterministic LLM Prompts with Future AGI, accessed April 15, 2026, [https://futureagi.com/blog/non-deterministic-llm-prompts-2025/](https://futureagi.com/blog/non-deterministic-llm-prompts-2025/)  
42. Defeating Nondeterminism in LLM Inference \- Hacker News, accessed April 15, 2026, [https://news.ycombinator.com/item?id=45200925](https://news.ycombinator.com/item?id=45200925)  
43. Structured model outputs | OpenAI API, accessed April 15, 2026, [https://developers.openai.com/api/docs/guides/structured-outputs](https://developers.openai.com/api/docs/guides/structured-outputs)  
44. Guiding LLMs The Right Way: Fast, Non-Invasive Constrained Generation \- arXiv, accessed April 15, 2026, [https://arxiv.org/html/2403.06988v1](https://arxiv.org/html/2403.06988v1)  
45. LLM Output Parsing and Structured Generation Guide \- Tetrate, accessed April 15, 2026, [https://tetrate.io/learn/ai/llm-output-parsing-structured-generation](https://tetrate.io/learn/ai/llm-output-parsing-structured-generation)  
46. Every Way To Get Structured Output From LLMs | BAML Blog, accessed April 15, 2026, [https://boundaryml.com/blog/structured-output-from-llms](https://boundaryml.com/blog/structured-output-from-llms)  
47. autonomous-agent-readiness | Skills ... \- LobeHub, accessed April 15, 2026, [https://lobehub.com/skills/petekp-agent-skills-autonomous-agent-readiness](https://lobehub.com/skills/petekp-agent-skills-autonomous-agent-readiness)  
48. Self-Improving Coding Agents \- Addy Osmani, accessed April 15, 2026, [https://addyosmani.com/blog/self-improving-agents/](https://addyosmani.com/blog/self-improving-agents/)  
49. Avoiding Negative Side Effects of Autonomous Systems in the Open World, accessed April 15, 2026, [https://www.jair.org/index.php/jair/article/view/13581](https://www.jair.org/index.php/jair/article/view/13581)  
50. git-diff Documentation \- Git, accessed April 15, 2026, [https://git-scm.com/docs/git-diff](https://git-scm.com/docs/git-diff)  
51. How can I see what has changed in a file before committing to git? \- Stack Overflow, accessed April 15, 2026, [https://stackoverflow.com/questions/4456532/how-can-i-see-what-has-changed-in-a-file-before-committing-to-git](https://stackoverflow.com/questions/4456532/how-can-i-see-what-has-changed-in-a-file-before-committing-to-git)  
52. Git Commands \- Basic Snapshotting, accessed April 15, 2026, [https://git-scm.com/book/en/v2/Appendix-C:-Git-Commands-Basic-Snapshotting](https://git-scm.com/book/en/v2/Appendix-C:-Git-Commands-Basic-Snapshotting)  
53. Do we think of Git commits as diffs, snapshots, and/or histories? \- Hacker News, accessed April 15, 2026, [https://news.ycombinator.com/item?id=38888527](https://news.ycombinator.com/item?id=38888527)  
54. File System based file changes history on snapshots. LVM. ZFS. BTRFS \- Технологist, accessed April 15, 2026, [https://www.kvdm.dev/articles/file-system-based-file-changes-history-on-snapshots-lvm-zfs-btrfs/](https://www.kvdm.dev/articles/file-system-based-file-changes-history-on-snapshots-lvm-zfs-btrfs/)  
55. From Commands to Prompts: LLM-based Semantic File System for AIOS | OpenReview, accessed April 15, 2026, [https://openreview.net/forum?id=2G021ZqUEZ](https://openreview.net/forum?id=2G021ZqUEZ)  
56. Language Server CLI Empowers Language Agents with Process Rewards \- arXiv, accessed April 15, 2026, [https://arxiv.org/html/2510.22907v1](https://arxiv.org/html/2510.22907v1)  
57. The Learning Loop and LLMs \- Martin Fowler, accessed April 15, 2026, [https://martinfowler.com/articles/llm-learning-loop.html](https://martinfowler.com/articles/llm-learning-loop.html)  
58. ruvnet/SAFLA: Self-Aware Feedback Loop Algorithm (python) \- GitHub, accessed April 15, 2026, [https://github.com/ruvnet/SAFLA](https://github.com/ruvnet/SAFLA)  
59. Skill Learning: Bringing Continual Learning to CLI Agents | Letta, accessed April 15, 2026, [https://www.letta.com/blog/skill-learning](https://www.letta.com/blog/skill-learning)  
60. e2b-dev/awesome-ai-agents: A list of AI autonomous agents \- GitHub, accessed April 15, 2026, [https://github.com/e2b-dev/awesome-ai-agents](https://github.com/e2b-dev/awesome-ai-agents)  
61. NousResearch/hermes-agent: The agent that grows with you \- GitHub, accessed April 15, 2026, [https://github.com/nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent)  
62. A curated list of awesome skills, tools, integrations, and resources for Hermes Agent by Nous Research \- GitHub, accessed April 15, 2026, [https://github.com/0xNyk/awesome-hermes-agent](https://github.com/0xNyk/awesome-hermes-agent)  
63. PILOT: Command-line Interface Fuzzing via Path-Guided, Iterative Large Language Model Prompting \- arXiv, accessed April 15, 2026, [https://arxiv.org/html/2511.20555v2](https://arxiv.org/html/2511.20555v2)  
64. LLM-Fuzzer: Scaling Assessment of Large Language Model Jailbreaks \- USENIX, accessed April 15, 2026, [https://www.usenix.org/system/files/usenixsecurity24-yu-jiahao.pdf?utm\_source=chatgpt.com](https://www.usenix.org/system/files/usenixsecurity24-yu-jiahao.pdf?utm_source=chatgpt.com)  
65. Minimal LLM-based fuzz harness generator \- Ada Logics, accessed April 15, 2026, [https://adalogics.com/blog/minimal-llm-based-fuzz-harness-generator](https://adalogics.com/blog/minimal-llm-based-fuzz-harness-generator)  
66. All You Need Is A Fuzzing Brain: An LLM-Powered System for Automated Vulnerability Detection and Patching \- arXiv, accessed April 15, 2026, [https://arxiv.org/html/2509.07225v1](https://arxiv.org/html/2509.07225v1)  
67. Automated LLM-Tailored Prompt Optimization for Test Case Generation \- arXiv, accessed April 15, 2026, [https://arxiv.org/html/2501.01329v1](https://arxiv.org/html/2501.01329v1)

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADYAAAAYCAYAAACx4w6bAAAB10lEQVR4Xu2WzSsFYRSHj49kwUYpxEI+UhZSPpI1hY3srEiSIiVkQZEVG/+AlYWk2FIkOyWKRL6LfMeKBTb4nTnz3qbT7c7cyx0W89RT9/7OfeuemTnvvEQBAQF+UAO3PbgJN2CZLPtzquEIHIXlqmYxA3dhE8yDWXAVfsFmmGnnbXZWKMv+lEF4CFtgKzyFvc4fJMMTmOEMwT18Jak7uYFJKvObEpILXOHI6uEHLDZBHZwKlQWzcEXliXBHZT+lXwcemIYvKkuBnySPpUU7LDBfbLpJGhtWeTrJM/2bzMIiHbqwB690SNLsug6dLJA0VqULcaAWLuvQhVuS8dE8wSMdOnkk6d6vWeqBXTqMAM9SuAb4f7NhKSW5W9FeRQNvQjkxOAeX7M9uvMNjHZI0dadDA189bmxIFzzCG9F8DG6RDP8YucM785kOwTPc16FhkaSxSl2II/xe5KHnefMCXwT9yCWQPKJ6J7fgIg+gn/OVCg9gri5EYJzk7vJaAx8q+Ib0ObIQvAtycU0X4kgnHNChC/x64sMDn4oMHfCBpEELHtYLeElyp95sr+E5zDc/jBN89tSnGy80kJyOJuAkSQ+88f0bsnUQBWmwkaRJPjwEBAQEBITlG9dkaodqu5L+AAAAAElFTkSuQmCC>