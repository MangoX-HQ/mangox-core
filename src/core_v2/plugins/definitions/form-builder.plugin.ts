import { definePlugin, PluginDefinition, PluginContext } from "../plugin-manager";
import { IntermediateQuery } from "../../query/intermediate";
import { Document } from "mongodb";

export const formBuilderPlugin: PluginDefinition = definePlugin("use_form_builder", {
  description: "Removes $project stage from pipeline so all fields are returned",
  phases: ["main"],
  priority: 60,
  enabled: true,

  main: async (
    _query: IntermediateQuery,
    _context: PluginContext,
    nativeQuery?: unknown,
  ): Promise<void> => {
    if (!Array.isArray(nativeQuery)) return;

    const pipeline = nativeQuery as Document[];
    const idx = pipeline.findIndex((stage) => "$project" in stage);
    if (idx !== -1) pipeline.splice(idx, 1);
  },
});
