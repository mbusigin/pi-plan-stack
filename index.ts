/**
 * Plan Stack Extension v3 — Small Model Robustness
 *
 * Each task is a contract with an expected output. The auto-continue loop
 * validates that real work was done (tool calls) before proceeding.
 * All state changes are journaled to ~/.pi/plans/<plan-id>/.
 *
 * Tools: plan:push, plan:pop, plan:save, plan:query
 * Commands: /plan, /plan:clear
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Data Model ─────────────────────────────────────────────

interface PlanNode {
	id: number;
	description: string;
	expectedOutput: string;
	status: "pending" | "done";
	children: PlanNode[];
	parentId: number | null;
}

interface PlanState {
	nodes: PlanNode[];
	nextId: number;
	focusId: number | null;
	planDir: string | null;
	goal: string | null;
}

interface PlanDetails {
	action: "push" | "pop";
	state: PlanState;
	error?: string;
}

interface JournalEntry {
	ts: string;
	type: string;
	taskId?: number;
	data?: unknown;
}

// ─── Constants ──────────────────────────────────────────────

const PLANS_DIR = join(homedir(), ".pi", "plans");
const MAX_RETRIES = 3;

// ─── Flat Index ─────────────────────────────────────────────

let nodeMap = new Map<number, PlanNode>();
let taskTurnCount = new Map<number, number>();
let projectDir = process.cwd();
let driftWarning: string | null = null;

function rebuildMap(nodes: PlanNode[]) {
	nodeMap.clear();
	const walk = (list: PlanNode[]) => {
		for (const n of list) {
			nodeMap.set(n.id, n);
			walk(n.children);
		}
	};
	walk(nodes);
}

// ─── Focus: DFS leftmost-deepest pending leaf ───────────────

function findFocus(nodes: PlanNode[]): number | null {
	for (const node of nodes) {
		if (node.status === "done") continue;
		const childFocus = findFocus(node.children);
		if (childFocus !== null) return childFocus;
		return node.id;
	}
	return null;
}

// ─── Focused Context (compact, for small models) ────────────

function findNextPending(nodes: PlanNode[], afterId: number | null): PlanNode | null {
	let foundCurrent = afterId === null;
	const walk = (list: PlanNode[]): PlanNode | null => {
		for (const node of list) {
			if (node.status === "done") {
				const child = walk(node.children);
				if (child) return child;
				continue;
			}
			if (node.id === afterId) {
				foundCurrent = true;
				const child = walk(node.children);
				if (child) return child;
				continue;
			}
			if (foundCurrent) {
				const childFocus = findFocus([node]);
				if (childFocus !== null) return nodeMap.get(childFocus) ?? null;
				return node;
			}
			const child = walk(node.children);
			if (child) return child;
		}
		return null;
	};
	return walk(nodes);
}

function renderFocusedContext(state: PlanState, cwd: string): string {
	const { done, total } = countTasks(state.nodes);
	const focus = state.focusId !== null ? nodeMap.get(state.focusId) : null;
	const lines = [`<task>`, `PROJECT: ${cwd}`];
	if (state.goal) {
		lines.push(`GOAL: ${state.goal.slice(0, 100)}`);
	}
	if (focus) {
		lines.push(`NOW: #${focus.id} "${focus.description}" -> ${focus.expectedOutput}`);
	}
	lines.push(`PROGRESS: ${done}/${total} done`);
	const next = findNextPending(state.nodes, state.focusId);
	if (next && next.id !== focus?.id) {
		lines.push(`NEXT: #${next.id} "${next.description}"`);
	}
	lines.push(`Only work within ${cwd}. Do not explore system paths.`);
	lines.push(`</task>`);
	return lines.join("\n");
}

// ─── Drift Detection ────────────────────────────────────────

function detectDrift(toolOutputs: { name: string; output: string }[]): string | null {
	const systemPaths = ["/bin/", "/usr/bin/", "/etc/", "/sbin/", "/mnt/", "/opt/"];
	for (const t of toolOutputs) {
		if (t.name === "bash") {
			for (const sp of systemPaths) {
				if (t.output.includes(sp) && !t.output.includes(projectDir)) {
					return `WARNING: You explored ${sp}. Return to ${projectDir}.`;
				}
			}
		}
	}
	return null;
}

// ─── Tree Rendering ─────────────────────────────────────────

function renderTree(nodes: PlanNode[], focusId: number | null, indent = 0): string[] {
	const lines: string[] = [];
	for (const node of nodes) {
		const marker = node.status === "done" ? "\u2713" : "\u25CB";
		const focus = node.id === focusId ? " \u25C0" : "";
		const prefix = "  ".repeat(indent);
		lines.push(`${prefix}${marker} #${node.id} ${node.description}${focus}`);
		if (node.expectedOutput && node.status !== "done") {
			lines.push(`${prefix}  \u2192 ${node.expectedOutput}`);
		}
		if (node.children.length > 0) {
			lines.push(...renderTree(node.children, focusId, indent + 1));
		}
	}
	return lines;
}

function renderThemedTree(nodes: PlanNode[], focusId: number | null, theme: Theme, indent = 0): string[] {
	const lines: string[] = [];
	for (const node of nodes) {
		const marker = node.status === "done" ? theme.fg("success", "\u2713") : theme.fg("dim", "\u25CB");
		const focus = node.id === focusId ? theme.fg("warning", " \u25C0") : "";
		const prefix = "  ".repeat(indent);
		const id = theme.fg("accent", `#${node.id}`);
		const desc = node.status === "done" ? theme.fg("dim", node.description) : theme.fg("text", node.description);
		lines.push(`${prefix}${marker} ${id} ${desc}${focus}`);
		if (node.expectedOutput && node.status !== "done") {
			lines.push(`${prefix}  ${theme.fg("muted", "\u2192")} ${theme.fg("dim", node.expectedOutput)}`);
		}
		if (node.children.length > 0) {
			lines.push(...renderThemedTree(node.children, focusId, theme, indent + 1));
		}
	}
	return lines;
}

// ─── Stats ──────────────────────────────────────────────────

function countTasks(nodes: PlanNode[]): { done: number; total: number } {
	let done = 0;
	let total = 0;
	const walk = (list: PlanNode[]) => {
		for (const n of list) {
			total++;
			if (n.status === "done") done++;
			walk(n.children);
		}
	};
	walk(nodes);
	return { done, total };
}

// ─── Deep Clone ─────────────────────────────────────────────

function cloneNodes(nodes: PlanNode[]): PlanNode[] {
	return nodes.map((n) => ({ ...n, children: cloneNodes(n.children) }));
}

// ─── Journal I/O ────────────────────────────────────────────

function ensurePlanDir(state: PlanState): string {
	if (!state.planDir) {
		const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		state.planDir = join(PLANS_DIR, id);
	}
	mkdirSync(join(state.planDir, "tasks"), { recursive: true });
	return state.planDir;
}

function ensureTaskDir(state: PlanState, taskId: number): string {
	const planDir = ensurePlanDir(state);
	const taskDir = join(planDir, "tasks", String(taskId));
	mkdirSync(join(taskDir, "outputs"), { recursive: true });
	mkdirSync(join(taskDir, "turns"), { recursive: true });
	return taskDir;
}

function journalPlan(state: PlanState, entry: JournalEntry) {
	try {
		const dir = ensurePlanDir(state);
		appendFileSync(join(dir, "journal.jsonl"), JSON.stringify(entry) + "\n");
	} catch (e) {
		console.error(`[plan-stack] journal write failed: ${e}`);
	}
}

function journalTask(state: PlanState, taskId: number, entry: JournalEntry) {
	try {
		const taskDir = ensureTaskDir(state, taskId);
		appendFileSync(join(taskDir, "journal.jsonl"), JSON.stringify(entry) + "\n");
	} catch (e) {
		console.error(`[plan-stack] task journal write failed: ${e}`);
	}
}

function savePlanSnapshot(state: PlanState) {
	try {
		const dir = ensurePlanDir(state);
		writeFileSync(join(dir, "plan.json"), JSON.stringify(state, null, 2));
	} catch (e) {
		console.error(`[plan-stack] snapshot write failed: ${e}`);
	}
}

// ─── UI Overlay ─────────────────────────────────────────────

class PlanListComponent {
	private nodes: PlanNode[];
	private focusId: number | null;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private goal: string | null;

	constructor(nodes: PlanNode[], focusId: number | null, goal: string | null, theme: Theme, onClose: () => void) {
		this.nodes = nodes;
		this.focusId = focusId;
		this.goal = goal;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Plan ");
		lines.push(truncateToWidth(
			th.fg("borderMuted", "\u2500".repeat(3)) + title + th.fg("borderMuted", "\u2500".repeat(Math.max(0, width - 9))),
			width,
		));
		lines.push("");

		if (this.goal) {
			lines.push(truncateToWidth(`  ${th.fg("muted", "Goal:")} ${th.fg("text", this.goal)}`, width));
			lines.push("");
		}

		if (this.nodes.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks yet. Ask the agent to create a plan!")}`, width));
		} else {
			const { done, total } = countTasks(this.nodes);
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${total} completed`)}`, width));
			if (this.focusId !== null) {
				const focusNode = nodeMap.get(this.focusId);
				if (focusNode) {
					lines.push(truncateToWidth(
						`  ${th.fg("muted", "Focus:")} ${th.fg("accent", `#${focusNode.id}`)} ${th.fg("text", focusNode.description)}`,
						width,
					));
					if (focusNode.expectedOutput) {
						lines.push(truncateToWidth(
							`  ${th.fg("muted", "Expects:")} ${th.fg("dim", focusNode.expectedOutput)}`,
							width,
						));
					}
				}
			}
			lines.push("");
			for (const tl of renderThemedTree(this.nodes, this.focusId, th)) {
				lines.push(truncateToWidth(`  ${tl}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ─── Extension Entry Point ──────────────────────────────────

export default function (pi: ExtensionAPI) {
	let state: PlanState = { nodes: [], nextId: 1, focusId: null, planDir: null, goal: null };

	// Validation tracking
	let runToolCalls: string[] = [];
	let focusRetryCount = 0;
	let lastFocusId: number | null = null;
	let lastUserMessage: string | null = null;
	let noPlanRetries = 0;
	const MAX_NO_PLAN_RETRIES = 2;

	// ─── State Reconstruction ───

	const reconstructState = (ctx: ExtensionContext) => {
		state = { nodes: [], nextId: 1, focusId: null, planDir: null, goal: null };
		nodeMap.clear();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult") continue;
			if (msg.toolName !== "plan:push" && msg.toolName !== "plan:pop") continue;

			const details = msg.details as PlanDetails | undefined;
			if (details?.state) {
				state = {
					nodes: details.state.nodes,
					nextId: details.state.nextId,
					focusId: details.state.focusId,
					planDir: details.state.planDir ?? null,
					goal: details.state.goal ?? null,
				};
			}
		}

		rebuildMap(state.nodes);
		focusRetryCount = 0;
		lastFocusId = null;
		lastUserMessage = null;
		runToolCalls = [];
		taskTurnCount.clear();
		noPlanRetries = 0;
		updateUI(ctx);
	};

	pi.on("session_start", async (_event, ctx) => { projectDir = ctx.cwd; reconstructState(ctx); });
	pi.on("session_switch", async (_event, ctx) => { projectDir = ctx.cwd; reconstructState(ctx); });
	pi.on("session_fork", async (_event, ctx) => { projectDir = ctx.cwd; reconstructState(ctx); });
	pi.on("session_tree", async (_event, ctx) => { projectDir = ctx.cwd; reconstructState(ctx); });

	// ─── UI Helpers ───

	const updateUI = (ctx: ExtensionContext) => {
		const { done, total } = countTasks(state.nodes);
		if (total === 0) {
			ctx.ui.setStatus("plan", "");
			ctx.ui.setWidget("plan-stack", []);
			return;
		}

		ctx.ui.setStatus("plan", `plan: ${done}/${total}`);

		const treeLines = renderTree(state.nodes, state.focusId);
		const goalLine = state.goal ? [`Goal: ${state.goal.slice(0, 80)}`] : [];
		const widgetLines = [`Plan (${done}/${total}):`, ...goalLine, ...treeLines.slice(0, 20)];
		if (treeLines.length > 20) widgetLines.push(`... ${treeLines.length - 20} more`);
		ctx.ui.setWidget("plan-stack", widgetLines);
	};

	const makeSnapshot = (): PlanState => ({
		nodes: cloneNodes(state.nodes),
		nextId: state.nextId,
		focusId: state.focusId,
		planDir: state.planDir,
		goal: state.goal,
	});

	// ─── Tool: plan:push ───

	pi.registerTool({
		name: "plan:push",
		label: "Plan Push",
		description:
			"Add a task to the plan. Each task is a contract: specify what to do and what concrete output is expected. " +
			"Without parent_id, adds as root task. With parent_id, adds as sub-task. " +
			"Use sub-tasks liberally — break any multi-step task into smaller pieces. " +
			"IMPORTANT: On your FIRST plan:push call, you MUST set the 'goal' parameter to the user's original request verbatim.",
		parameters: Type.Object({
			description: Type.String({ description: "What this task should accomplish" }),
			expected_output: Type.String({
				description:
					"Concrete deliverable. Examples: 'nmap scan results saved to /tmp/nmap-results.txt', " +
					"'list of open ports printed via tool output', 'source file created at src/foo.ts'",
			}),
			parent_id: Type.Optional(Type.Number({ description: "Parent task ID to nest under" })),
			goal: Type.Optional(Type.String({ description: "The user's overall objective (set this on the FIRST plan:push only)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Capture the user's overall goal on first push
			if (params.goal && !state.goal) {
				state.goal = params.goal;
			}

			const newNode: PlanNode = {
				id: state.nextId++,
				description: params.description,
				expectedOutput: params.expected_output,
				status: "pending",
				children: [],
				parentId: params.parent_id ?? null,
			};

			if (params.parent_id !== undefined) {
				const parent = nodeMap.get(params.parent_id);
				if (!parent) {
					return {
						content: [{ type: "text", text: `Error: parent task #${params.parent_id} not found` }],
						details: {
							action: "push",
							state: makeSnapshot(),
							error: `parent #${params.parent_id} not found`,
						} as PlanDetails,
					};
				}
				parent.children.push(newNode);
			} else {
				state.nodes.push(newNode);
			}

			nodeMap.set(newNode.id, newNode);
			state.focusId = findFocus(state.nodes);

			// Journal
			const now = new Date().toISOString();
			if (params.goal && state.goal === params.goal) {
				journalPlan(state, {
					ts: now,
					type: "goal_set",
					data: { goal: state.goal },
				});
			}
			journalPlan(state, {
				ts: now,
				type: "task_pushed",
				taskId: newNode.id,
				data: {
					description: newNode.description,
					expectedOutput: newNode.expectedOutput,
					parentId: newNode.parentId,
				},
			});
			journalTask(state, newNode.id, {
				ts: now,
				type: "created",
				taskId: newNode.id,
				data: {
					description: newNode.description,
					expectedOutput: newNode.expectedOutput,
				},
			});
			savePlanSnapshot(state);

			updateUI(ctx);

			const tree = renderTree(state.nodes, state.focusId);
			return {
				content: [
					{
						type: "text",
						text: `Added #${newNode.id}: ${newNode.description}\nExpected: ${newNode.expectedOutput}\n\n${tree.join("\n")}`,
					},
				],
				details: { action: "push", state: makeSnapshot() } as PlanDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("plan:push "));
			text += theme.fg("dim", `"${args.description}"`);
			if (args.parent_id !== undefined) {
				text += theme.fg("muted", " under ") + theme.fg("accent", `#${args.parent_id}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as PlanDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			if (!details?.state) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const { done, total } = countTasks(details.state.nodes);
			let output = theme.fg("success", "\u2713 ") + theme.fg("muted", `Task added (${done}/${total})`);
			if (expanded) {
				const tree = renderThemedTree(details.state.nodes, details.state.focusId, theme);
				output += "\n" + tree.map((l) => `  ${l}`).join("\n");
			}
			return new Text(output, 0, 0);
		},
	});

	// ─── Tool: plan:pop ───

	pi.registerTool({
		name: "plan:pop",
		label: "Plan Pop",
		description:
			"Mark a task as done. Only call this AFTER the expected output has actually been produced. " +
			"Without id, marks the current focus. With id, marks that specific task.",
		parameters: Type.Object({
			id: Type.Optional(Type.Number({ description: "Task ID to mark done (defaults to current focus)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let targetId = params.id;

			if (targetId === undefined) {
				targetId = state.focusId;
				if (targetId === null) {
					return {
						content: [{ type: "text", text: "Error: no pending tasks to complete" }],
						details: { action: "pop", state: makeSnapshot(), error: "no pending tasks" } as PlanDetails,
					};
				}
			}

			const node = nodeMap.get(targetId);
			if (!node) {
				return {
					content: [{ type: "text", text: `Error: task #${targetId} not found` }],
					details: { action: "pop", state: makeSnapshot(), error: `task #${targetId} not found` } as PlanDetails,
				};
			}

			if (node.status === "done") {
				return {
					content: [{ type: "text", text: `Error: task #${targetId} is already done` }],
					details: { action: "pop", state: makeSnapshot(), error: `task #${targetId} already done` } as PlanDetails,
				};
			}

			node.status = "done";
			state.focusId = findFocus(state.nodes);

			// Journal
			const now = new Date().toISOString();
			journalPlan(state, { ts: now, type: "task_completed", taskId: node.id });
			journalTask(state, node.id, { ts: now, type: "completed", taskId: node.id });
			savePlanSnapshot(state);

			// Reset retry tracking — focus changed
			focusRetryCount = 0;
			lastFocusId = state.focusId;

			updateUI(ctx);

			const tree = renderTree(state.nodes, state.focusId);
			const { done, total } = countTasks(state.nodes);
			return {
				content: [
					{
						type: "text",
						text: `Completed #${node.id}: ${node.description} (${done}/${total})\n\n${tree.join("\n")}`,
					},
				],
				details: { action: "pop", state: makeSnapshot() } as PlanDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("plan:pop"));
			if (args.id !== undefined) text += " " + theme.fg("accent", `#${args.id}`);
			else text += " " + theme.fg("dim", "(focus)");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as PlanDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			if (!details?.state) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const { done, total } = countTasks(details.state.nodes);
			let output = theme.fg("success", "\u2713 ") + theme.fg("muted", `Task completed (${done}/${total})`);
			if (expanded) {
				const tree = renderThemedTree(details.state.nodes, details.state.focusId, theme);
				output += "\n" + tree.map((l) => `  ${l}`).join("\n");
			}
			return new Text(output, 0, 0);
		},
	});

	// ─── Tool: plan:save ───

	pi.registerTool({
		name: "plan:save",
		label: "Plan Save Output",
		description:
			"Save an intermediate output for a task. Stores data under the task's directory so other tasks can query it later via plan:query. " +
			"Use this to persist important results, findings, or data that downstream tasks will need.",
		parameters: Type.Object({
			name: Type.String({ description: "Output filename (e.g., 'scan-results.txt', 'endpoints.json', 'analysis.md')" }),
			content: Type.String({ description: "The content to save" }),
			task_id: Type.Optional(Type.Number({ description: "Task ID (defaults to current focus)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const targetId = params.task_id ?? state.focusId;
			if (targetId === null) {
				return {
					content: [{ type: "text", text: "Error: no task to save output for" }],
				};
			}
			const node = nodeMap.get(targetId);
			if (!node) {
				return {
					content: [{ type: "text", text: `Error: task #${targetId} not found` }],
				};
			}

			try {
				const taskDir = ensureTaskDir(state, targetId);
				const outPath = join(taskDir, "outputs", params.name);
				writeFileSync(outPath, params.content);
				journalTask(state, targetId, {
					ts: new Date().toISOString(),
					type: "output_saved",
					taskId: targetId,
					data: { name: params.name, size: params.content.length },
				});
				return {
					content: [{ type: "text", text: `Saved output "${params.name}" for task #${targetId} (${params.content.length} bytes)` }],
				};
			} catch (e) {
				return {
					content: [{ type: "text", text: `Error saving output: ${e}` }],
				};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("plan:save "));
			text += theme.fg("dim", `"${args.name}"`);
			if (args.task_id !== undefined) {
				text += theme.fg("muted", " for ") + theme.fg("accent", `#${args.task_id}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme) {
			const text = result.content[0];
			const str = text?.type === "text" ? text.text : "";
			if (str.startsWith("Error")) return new Text(theme.fg("error", str), 0, 0);
			return new Text(theme.fg("success", "\u2713 ") + theme.fg("muted", str), 0, 0);
		},
	});

	// ─── Tool: plan:query ───

	pi.registerTool({
		name: "plan:query",
		label: "Plan Query Output",
		description:
			"Query intermediate outputs from any task. Without a name, lists all available outputs and turn logs for a task. " +
			"With a name, reads that specific output file. Use this to access results from previously completed (or in-progress) tasks.",
		parameters: Type.Object({
			task_id: Type.Number({ description: "Task ID to query outputs from" }),
			name: Type.Optional(Type.String({ description: "Output filename to read (omit to list available outputs)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const node = nodeMap.get(params.task_id);
			if (!node) {
				return {
					content: [{ type: "text", text: `Error: task #${params.task_id} not found` }],
				};
			}

			const planDir = state.planDir;
			if (!planDir) {
				return {
					content: [{ type: "text", text: `Error: no plan directory exists yet` }],
				};
			}

			const taskDir = join(planDir, "tasks", String(params.task_id));

			if (!params.name) {
				// List available outputs and turns
				const items: string[] = [];
				const outputsDir = join(taskDir, "outputs");
				const turnsDir = join(taskDir, "turns");

				if (existsSync(outputsDir)) {
					try {
						const files = readdirSync(outputsDir);
						for (const f of files) {
							items.push(`output: ${f}`);
						}
					} catch { /* ignore */ }
				}
				if (existsSync(turnsDir)) {
					try {
						const files = readdirSync(turnsDir).sort();
						for (const f of files) {
							items.push(`turn: ${f}`);
						}
					} catch { /* ignore */ }
				}

				if (items.length === 0) {
					return {
						content: [{ type: "text", text: `Task #${params.task_id} has no stored outputs yet.` }],
					};
				}
				return {
					content: [{ type: "text", text: `Task #${params.task_id} (${node.description}):\n${items.map((i) => `  ${i}`).join("\n")}` }],
				};
			}

			// Read specific output — check outputs/ first, then turns/
			const candidates = [
				join(taskDir, "outputs", params.name),
				join(taskDir, "turns", params.name),
			];

			for (const filePath of candidates) {
				if (existsSync(filePath)) {
					try {
						const content = readFileSync(filePath, "utf-8");
						return {
							content: [{ type: "text", text: content }],
						};
					} catch (e) {
						return {
							content: [{ type: "text", text: `Error reading ${params.name}: ${e}` }],
						};
					}
				}
			}

			return {
				content: [{ type: "text", text: `Output "${params.name}" not found for task #${params.task_id}` }],
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("plan:query "));
			text += theme.fg("accent", `#${args.task_id}`);
			if (args.name) text += theme.fg("dim", ` "${args.name}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme) {
			const text = result.content[0];
			const str = text?.type === "text" ? text.text : "";
			if (str.startsWith("Error")) return new Text(theme.fg("error", str), 0, 0);
			return new Text(theme.fg("muted", str), 0, 0);
		},
	});

	// ─── Turn Tracking for Validation ───

	pi.on("turn_end", async (event, _ctx) => {
		if (event.toolResults) {
			const toolOutputs: { name: string; output: string }[] = [];
			for (const tr of event.toolResults as any[]) {
				const name = tr.toolName as string | undefined;
				if (name && !name.startsWith("plan:")) {
					runToolCalls.push(name);
					// Extract text content for auto-capture
					let output = "";
					if (Array.isArray(tr.content)) {
						for (const block of tr.content) {
							if (block.type === "text") output += block.text + "\n";
						}
					}
					toolOutputs.push({ name, output: output.trim() });
				}
			}
			// Drift detection
			if (state.focusId !== null && toolOutputs.length > 0) {
				const drift = detectDrift(toolOutputs);
				if (drift) {
					driftWarning = drift;
					journalPlan(state, {
						ts: new Date().toISOString(),
						type: "drift_detected",
						taskId: state.focusId,
						data: { warning: drift },
					});
				}
			}
			// Auto-capture turn outputs to task directory
			if (state.focusId !== null && toolOutputs.length > 0) {
				try {
					const taskDir = ensureTaskDir(state, state.focusId);
					const turnNum = (taskTurnCount.get(state.focusId) ?? 0) + 1;
					taskTurnCount.set(state.focusId, turnNum);
					writeFileSync(
						join(taskDir, "turns", `turn-${turnNum}.json`),
						JSON.stringify({ ts: new Date().toISOString(), tools: toolOutputs }, null, 2),
					);
				} catch (e) {
					console.error(`[plan-stack] turn capture failed: ${e}`);
				}
			}
		}
	});

	// ─── System Prompt: Always Use Plans ───

	pi.on("before_agent_start", async (_event, ctx) => {
		projectDir = ctx.cwd;
		const { total } = countTasks(state.nodes);

		if (total > 0) {
			// Plan exists — inject systemPrompt to ground the model
			const focusNode = state.focusId !== null ? nodeMap.get(state.focusId) : null;
			const sysLines = [
				`Working directory: ${projectDir}`,
			];
			if (focusNode) {
				sysLines.push(`Current task: #${focusNode.id} "${focusNode.description}" -> ${focusNode.expectedOutput}`);
			}
			sysLines.push(`All file operations must be within the working directory. Do not explore /bin, /usr, /etc, /mnt.`);
			return { systemPrompt: sysLines.join("\n") };
		}

		// No plan yet — forcefully instruct the LLM to plan FIRST
		return {
			systemPrompt: `Working directory: ${projectDir}\nYou MUST create a plan with plan:push before doing any other work.`,
			message: {
				customType: "plan-stack-system",
				content: [
					`[MANDATORY PLANNING]`,
					`Working directory: ${projectDir}`,
					`Your FIRST action must be plan:push with goal, description, and expected_output.`,
					`Push 3-8 tasks BEFORE doing any work. Break complex tasks into sub-tasks with parent_id.`,
					`Save intermediate results with plan:save. The system auto-continues to next task.`,
					``,
					`plan:push FIRST. No exceptions. No exploration first. Plan immediately.`,
				].join("\n"),
				display: false,
			},
		};
	});

	// ─── Auto-Continue with Validation ───

	pi.on("agent_end", async (_event, ctx) => {
		const { done, total } = countTasks(state.nodes);

		// No plan was created — force the model to plan
		if (total === 0) {
			runToolCalls = [];
			noPlanRetries++;

			// Only force-continue if there's a user message and we haven't exceeded retries
			if (!lastUserMessage || noPlanRetries > MAX_NO_PLAN_RETRIES) return;

			const goalHint = lastUserMessage.length > 200 ? lastUserMessage.slice(0, 200) + "..." : lastUserMessage;
			pi.sendMessage(
				{
					customType: "plan-force",
					content: [
						`You did NOT create a plan. This is required.`,
						``,
						`The user asked: "${goalHint}"`,
						``,
						`You MUST call plan:push NOW. Example:`,
						`  plan:push(goal="${goalHint}", description="<first task>", expected_output="<deliverable>")`,
						``,
						`Do NOT do any other work. Call plan:push immediately.`,
					].join("\n"),
					display: false,
				},
				{ triggerTurn: true },
			);
			return;
		}

		// All done
		if (done === total) {
			journalPlan(state, { ts: new Date().toISOString(), type: "plan_completed" });
			runToolCalls = [];
			return;
		}

		const focusNode = state.focusId !== null ? nodeMap.get(state.focusId) : null;
		if (!focusNode) {
			runToolCalls = [];
			return;
		}

		// Capture this run's tool usage, then reset for next run
		const toolsUsed = [...runToolCalls];
		runToolCalls = [];
		const hadRealWork = toolsUsed.length > 0;

		// Track retries on same focus without real tool usage
		if (state.focusId === lastFocusId && !hadRealWork) {
			focusRetryCount++;
		} else if (state.focusId !== lastFocusId) {
			focusRetryCount = 0;
			lastFocusId = state.focusId;
		} else {
			// Same focus, had tool calls — progress is being made
			focusRetryCount = 0;
		}

		// Journal the agent run output
		journalTask(state, focusNode.id, {
			ts: new Date().toISOString(),
			type: "turn_output",
			taskId: focusNode.id,
			data: { toolCalls: toolsUsed, hadRealWork, retryCount: focusRetryCount },
		});

		// Too many retries without real work — skip this task
		if (focusRetryCount >= MAX_RETRIES) {
			journalTask(state, focusNode.id, {
				ts: new Date().toISOString(),
				type: "validation_failed",
				taskId: focusNode.id,
				data: { reason: `No tool usage after ${MAX_RETRIES} attempts` },
			});
			journalPlan(state, {
				ts: new Date().toISOString(),
				type: "task_skipped",
				taskId: focusNode.id,
			});

			focusNode.status = "done";
			state.focusId = findFocus(state.nodes);
			focusRetryCount = 0;
			lastFocusId = state.focusId;
			savePlanSnapshot(state);
			updateUI(ctx);
		}

		// Re-check after potential skip
		const { done: newDone, total: newTotal } = countTasks(state.nodes);
		if (newDone === newTotal) return;

		const nextFocus = state.focusId !== null ? nodeMap.get(state.focusId) : null;
		if (!nextFocus) return;

		const remaining = newTotal - newDone;
		const expected = nextFocus.expectedOutput || "Complete the task as described";

		let content: string;
		if (focusRetryCount > 0) {
			content = [
				`RETRY ${focusRetryCount + 1}/${MAX_RETRIES}: Task #${nextFocus.id}: ${nextFocus.description}`,
				`Suggested: bash("ls ${projectDir}/src/") or read a key file.`,
				`Stay in ${projectDir}. Do not explore system directories.`,
			].join("\n");
		} else {
			content = [
				`Task #${nextFocus.id}: ${nextFocus.description}`,
				`Expected: ${expected}`,
				`Working in: ${projectDir}`,
				`${remaining} task(s) left. When done, call plan:pop.`,
			].join("\n");
		}

		pi.sendMessage(
			{ customType: "plan-continue", content, display: false },
			{ triggerTurn: true },
		);
	});

	// ─── Context Injection ───

	pi.on("context", (event, ctx) => {
		projectDir = ctx.cwd;
		const messages = event.messages;
		if (!messages || messages.length === 0) return;

		// Always capture the latest user message (for goal auto-capture)
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "user") {
				const content = msg.content;
				if (typeof content === "string" && content.trim()) {
					lastUserMessage = content.trim();
				} else if (Array.isArray(content)) {
					for (const block of content) {
						if (typeof block === "object" && block.type === "text" && block.text?.trim()) {
							lastUserMessage = block.text.trim();
							break;
						}
					}
				}
				break;
			}
		}

		const { done, total } = countTasks(state.nodes);

		// If no plan exists, append "plan first" directive to last user message
		if (total === 0) {
			const planFirstBlock = [
				`<plan-directive>`,
				`PROJECT: ${projectDir}`,
				`STOP. Create a plan with plan:push before doing any work.`,
				`Push 3+ tasks, then execute. Plan IMMEDIATELY.`,
				`</plan-directive>`,
			].join("\n");

			const newMsgs = [...messages];
			for (let i = newMsgs.length - 1; i >= 0; i--) {
				if (newMsgs[i].role === "user") {
					const msg = { ...newMsgs[i] };
					let arr = typeof msg.content === "string"
						? [{ type: "text" as const, text: msg.content }]
						: [...(msg.content as any[])];
					arr.push({ type: "text" as const, text: planFirstBlock });
					msg.content = arr;
					newMsgs[i] = msg;
					break;
				}
			}
			return { messages: newMsgs };
		}

		if (done === total) return;

		// Auto-capture goal from user message if not explicitly set
		if (!state.goal && lastUserMessage) {
			state.goal = lastUserMessage;
		}

		// Build compact context block
		let compactBlock = "";
		if (driftWarning) {
			compactBlock = driftWarning + "\n";
			driftWarning = null;
		}
		compactBlock += renderFocusedContext(state, projectDir);

		// Append to last user message for maximum recency
		const newMessages = [...messages];
		for (let i = newMessages.length - 1; i >= 0; i--) {
			if (newMessages[i].role === "user") {
				const msg = { ...newMessages[i] };
				let arr = typeof msg.content === "string"
					? [{ type: "text" as const, text: msg.content }]
					: [...(msg.content as any[])];
				arr.push({ type: "text" as const, text: compactBlock });
				msg.content = arr;
				newMessages[i] = msg;
				break;
			}
		}

		return { messages: newMessages };
	});

	// ─── Commands ───

	pi.registerCommand("plan", {
		description: "Show the current plan tree",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/plan requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new PlanListComponent(state.nodes, state.focusId, state.goal, theme, () => done());
			});
		},
	});

	pi.registerCommand("plan:clear", {
		description: "Reset all plan tasks",
		handler: async (_args, ctx) => {
			if (state.planDir) {
				journalPlan(state, { ts: new Date().toISOString(), type: "plan_cleared" });
			}
			state = { nodes: [], nextId: 1, focusId: null, planDir: null, goal: null };
			nodeMap.clear();
			focusRetryCount = 0;
			lastFocusId = null;
			lastUserMessage = null;
			runToolCalls = [];
			taskTurnCount.clear();
			noPlanRetries = 0;
			updateUI(ctx);
			ctx.ui.notify("Plan cleared", "info");
		},
	});
}
