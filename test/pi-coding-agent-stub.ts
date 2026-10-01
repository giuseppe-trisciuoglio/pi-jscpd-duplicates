import type { EventEmitter } from "node:events";

export interface ExtensionAPI {
	on<E extends string>(event: E, listener: (...args: unknown[]) => void | Promise<unknown>): void;
	registerCommand(name: string, def: { description: string; handler: (...args: unknown[]) => unknown }): void;
	exec: (
		command: string,
		args: string[],
		options: { cwd?: string; timeout?: number },
	) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
	sendMessage: (msg: unknown, opts?: { triggerTurn?: boolean }) => void;
}

export interface ExtensionContext {
	cwd: string;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	hasUI: boolean;
	sessionManager: EventEmitter;
}

export default {} as ExtensionAPI;