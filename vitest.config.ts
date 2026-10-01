import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@earendil-works/pi-coding-agent": fileURLToPath(
				new URL("./test/pi-coding-agent-stub.ts", import.meta.url),
			),
		},
	},
	test: {
		root: fileURLToPath(new URL(".", import.meta.url)),
		include: ["test/**/*.test.ts"],
	},
});