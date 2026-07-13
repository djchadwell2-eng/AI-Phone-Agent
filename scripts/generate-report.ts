import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import { buildClientReport } from "../src/lib/report.js";
import { clientBySlug, db } from "../src/lib/supabase.js";

/**
 * Case-study / monthly-report generator.
 *   npm run report -- --slug summit-heating-air --month 2026-07
 * Writes reports/out/<slug>-<month>.md and stores it in the reports table.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("slug") ?? "summit-heating-air";
  const month = arg("month") ?? DateTime.now().toFormat("yyyy-LL");
  const client = await clientBySlug(slug);
  if (!client) throw new Error(`No client with slug '${slug}'`);

  const start = DateTime.fromFormat(month, "yyyy-LL", { zone: client.timezone }).startOf("month");
  const report = await buildClientReport({
    client,
    fromIso: start.toUTC().toISO()!,
    toIso: start.plus({ months: 1 }).toUTC().toISO()!,
    title: `${client.business_name} — ${start.toFormat("LLLL yyyy")} call capture report`,
  });

  mkdirSync(join("reports", "out"), { recursive: true });
  const outPath = join("reports", "out", `${slug}-${month}.md`);
  writeFileSync(outPath, report.markdown, "utf8");
  // Re-running a month replaces the stored copy (no unique constraint → delete+insert).
  await db().from("reports").delete().eq("client_id", client.id).eq("kind", "monthly").eq("period", month);
  await db().from("reports").insert({ client_id: client.id, kind: "monthly", period: month, markdown: report.markdown });

  console.log(report.markdown);
  console.log(`\n✓ written to ${outPath}\nHeadline: ${report.headline}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
