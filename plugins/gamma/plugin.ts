// Gamma: people and companies in Wave's network, from the person's Gamma connector in Claude.
// A built-in plugin (docs/plugins.md): off until turned on in Settings or the config file.
import { definePlugin, type PluginRow } from "../../src/plugin";

const SEARCH_PEOPLE = "mcp__claude_ai_Gamma__search_people";
const SEARCH_ORGANIZATIONS = "mcp__claude_ai_Gamma__search_organizations";

interface Person {
  id: string;
  name: string;
  headline?: string | null;
  organization?: string | null;
  city?: string | null;
  myWarmth?: string | null;
  waveWarmth?: string | null;
}
interface Organization {
  id: string;
  name: string;
  type?: string | null;
  industry?: string | null;
  currentEmployees?: number | null;
  linkedinUrl?: string | null;
  knownBy?: string[];
}

export function personRow(p: Person): PluginRow {
  const warmth = p.myWarmth && p.myWarmth !== "none" ? p.myWarmth : p.waveWarmth && p.waveWarmth !== "none" ? `Wave: ${p.waveWarmth}` : "";
  const detail = p.headline || [p.organization, p.city].filter(Boolean).join(" · ");
  return {
    title: p.name,
    ...(detail ? { detail } : {}),
    ...(warmth ? { meta: warmth } : {}),
    ...(p.myWarmth === "strong" ? { tone: "accent" as const } : {}),
    task: `Tell me about ${p.name} (Gamma person ${p.id}): who they are, how I and Wave know them, and our last interactions.`,
  };
}

export function organizationRow(o: Organization): PluginRow {
  const detail = [o.type, o.industry].filter(Boolean).join(" · ");
  const known = o.knownBy?.length ?? 0;
  return {
    title: o.name,
    ...(detail ? { detail } : {}),
    ...(known ? { meta: `${known} at Wave know` } : {}),
    ...(o.linkedinUrl ? { url: o.linkedinUrl } : {}),
    task: `Tell me about ${o.name} (Gamma company ${o.id}): what they do, who we know there and how warm, and anything Wave has on them.`,
  };
}

export default definePlugin({
  title: "Gamma",
  icon: "people",
  hotkey: "CommandOrControl+Alt+G",
  tools: [SEARCH_PEOPLE, SEARCH_ORGANIZATIONS],
  search: {
    placeholder: "Search people and companies in Gamma",
    async run(query, ctx) {
      if (!query) return { sections: [], note: "Type a name, a company or who you are looking for, then Enter." };
      // Three words or more read as a description ("fintech founders in Stockholm"), fewer as a name.
      const byDescription = query.split(/\s+/).length >= 3;
      const [people, organizations] = await Promise.all([
        ctx.tool<{ items?: Person[] }>(SEARCH_PEOPLE, byDescription ? { description: query, scope: "all", limit: 10 } : { name: query, scope: "all", sort: "warmth", limit: 10 }),
        byDescription ? Promise.resolve({ items: [] as Organization[] }) : ctx.tool<{ items?: Organization[] }>(SEARCH_ORGANIZATIONS, { name: query, limit: 5 }),
      ]);
      return {
        sections: [
          { title: "People", rows: (people?.items ?? []).map(personRow), empty: "No one found." },
          ...(byDescription ? [] : [{ title: "Companies", rows: (organizations?.items ?? []).map(organizationRow), empty: "No company found." }]),
        ],
      };
    },
  },
});
