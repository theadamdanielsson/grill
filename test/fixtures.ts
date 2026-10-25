// Shapes several test files build: a concept's record, a model config, the settings rows.
import { newConceptMastery, type ConceptMastery } from "../src/concepts";
import type { LLMConfig } from "../src/providers";

/** A concept record, untested unless `over` says otherwise. */
export function concept(over: Partial<ConceptMastery> = {}): ConceptMastery {
	return { ...newConceptMastery({ note: "N", label: "x", kind: "term", sourceHash: null }), ...over };
}

/** An Anthropic config whose calls go to the stub's `net.handler`. */
export function llmCfg(over: Partial<LLMConfig> = {}): LLMConfig {
	return { provider: "anthropic", apiKey: "k", model: "claude-sonnet-5-5", ...over };
}

/** The settings definitions under the tab bar: each tab's sections, then Tuning. */
export const sectionDefs = (tab: any): any[] => (tab.getSettingDefinitions() as any[]).filter((d) => d.cls !== "grill-settings-tabs-group");
