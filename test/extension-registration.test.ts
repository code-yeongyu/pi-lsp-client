import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { lsp_diagnostics } from "../src/lsp/tools/diagnostics.js";
import { lsp_find_references } from "../src/lsp/tools/find-references.js";
import { lsp_goto_definition } from "../src/lsp/tools/goto-definition.js";
import { lsp_prepare_rename, lsp_rename } from "../src/lsp/tools/rename.js";
import { lsp_symbols } from "../src/lsp/tools/symbols.js";

describe("lsp_diagnostics tool definition", () => {
	it("#given diagnostics tool #when inspecting metadata #then exposes expected name and label", () => {
		// given / when / then
		expect(lsp_diagnostics.name).toBe("lsp_diagnostics");
		expect(lsp_diagnostics.label).toBe("LSP Diagnostics");
		expect(lsp_diagnostics.description).toContain("language server");
	});

	it("#given diagnostics parameters #when inspecting schema #then requires filePath only", () => {
		// given
		const objectSchema = Type.Object({});
		const parameters = lsp_diagnostics.parameters;

		// when / then
		expect(parameters.type).toBe(objectSchema.type);
		expect(parameters.required).toEqual(["filePath"]);
		expect(parameters.properties).toHaveProperty("filePath");
		expect(parameters.properties).toHaveProperty("severity");
	});
});

describe("lsp_goto_definition tool definition", () => {
	it("#given goto tool #when inspecting metadata #then matches name and required params", () => {
		// given / when / then
		expect(lsp_goto_definition.name).toBe("lsp_goto_definition");
		expect(lsp_goto_definition.parameters.required).toEqual(["filePath", "line", "character"]);
	});
});

describe("lsp_find_references tool definition", () => {
	it("#given references tool #when inspecting metadata #then matches name and required params", () => {
		// given / when / then
		expect(lsp_find_references.name).toBe("lsp_find_references");
		expect(lsp_find_references.parameters.required).toEqual(["filePath", "line", "character"]);
	});
});

describe("lsp_symbols tool definition", () => {
	it("#given symbols tool #when inspecting metadata #then matches name and scope enum", () => {
		// given / when / then
		expect(lsp_symbols.name).toBe("lsp_symbols");
		expect(lsp_symbols.parameters.required).toContain("filePath");
		expect(lsp_symbols.parameters.required).toContain("scope");
	});
});

describe("lsp_prepare_rename tool definition", () => {
	it("#given prepare rename #when inspecting metadata #then matches name and is parallel-safe", () => {
		// given / when / then
		expect(lsp_prepare_rename.name).toBe("lsp_prepare_rename");
		expect(lsp_prepare_rename.executionMode).toBeUndefined();
		expect(lsp_prepare_rename.parameters.required).toEqual(["filePath", "line", "character"]);
	});
});

describe("lsp_rename tool definition", () => {
	it("#given rename tool #when inspecting metadata #then is sequential and requires newName", () => {
		// given / when / then
		expect(lsp_rename.name).toBe("lsp_rename");
		expect(lsp_rename.executionMode).toBe("sequential");
		expect(lsp_rename.parameters.required).toEqual(["filePath", "line", "character", "newName"]);
	});
});
