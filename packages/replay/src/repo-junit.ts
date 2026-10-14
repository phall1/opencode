import { Schema } from "effect"
import { lstatSync, readFileSync } from "node:fs"
import { Hash, encode, hash } from "./archive"

const count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
export const TestCounts = Schema.Struct({ tests: count, assertions: count, failures: count, skipped: count })
export const VerifierReport = Schema.Struct({
  format: Schema.Literal("bun-junit-v1"),
  parser: Hash,
  provenance: Schema.Literal("native Bun junit reporter; trusted fixture only, not tamper-proof"),
  state: Schema.Literals(["complete", "missing", "malformed", "unsafe", "oversized"]),
  raw: Schema.Union([Schema.String, Schema.Null]),
  digest: Schema.Union([Hash, Schema.Null]),
  counts: Schema.Union([TestCounts, Schema.Null]),
})
export type VerifierReport = typeof VerifierReport.Type
const parser = hash(readFileSync(import.meta.filename, "utf8"))
export const MAX_REPORT_BYTES = 65536

export function readVerifierReport(file: string): VerifierReport {
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (!stat) return evidence("missing", null)
  if (!stat.isFile()) return evidence("unsafe", null)
  if (stat.size > MAX_REPORT_BYTES) return evidence("oversized", null)
  const raw = readFileSync(file, "utf8")
  const counts = parseJunit(raw)
  return evidence(counts ? "complete" : "malformed", raw, counts)
}

function evidence(state: VerifierReport["state"], raw: string | null, counts?: typeof TestCounts.Type): VerifierReport {
  return {
    format: "bun-junit-v1",
    parser,
    provenance: "native Bun junit reporter; trusted fixture only, not tamper-proof",
    state,
    raw,
    digest: raw === null ? null : hash(raw),
    counts: counts ?? null,
  }
}

/** Only Bun's bounded, single-target suite shape; deliberately not a general XML parser. */
export function parseJunit(raw: string) {
  if (Buffer.byteLength(raw) > MAX_REPORT_BYTES) return
  const suite = raw.match(
    /^\s*<\?xml version="1\.0" encoding="UTF-8"\?>\s*<testsuites\b([^>]*)>\s*<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>\s*<\/testsuites>\s*$/,
  )
  if (!suite) return
  const counts = readCounts(suite[1])
  if (!counts || encode(counts) !== encode(readCounts(suite[2]) ?? null)) return
  return matchingCases(suite[3], counts)
}

function readCounts(attributes: string) {
  if (!validAttributes(attributes)) return
  const matches = [...attributes.matchAll(/\b(tests|assertions|failures|skipped)="(\d+)"/g)]
  if (matches.length !== 4) return
  const result = Schema.decodeUnknownOption(TestCounts)(
    Object.fromEntries(matches.map((match) => [match[1], Number(match[2])])),
  )
  return result._tag === "Some" ? result.value : undefined
}

function matchingCases(body: string, counts: typeof TestCounts.Type) {
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
  const cases = [...body.matchAll(pattern)].map(caseCounts)
  if (body.replace(pattern, "").trim() || cases.length !== counts.tests) return
  if (cases.some((value) => !value)) return
  const executed = cases.filter((value) => value !== undefined)
  if (executed.some((value) => value.skipped > 0 && value.assertions > 0)) return
  const total = executed.reduce(
    (sum, value) => ({
      tests: sum.tests + value.tests,
      assertions: sum.assertions + value.assertions,
      failures: sum.failures + value.failures,
      skipped: sum.skipped + value.skipped,
    }),
    { tests: 0, assertions: 0, failures: 0, skipped: 0 },
  )
  return encode(total) === encode(counts) ? counts : undefined
}

function caseCounts(match: RegExpMatchArray) {
  const assertions = readAssertions(match[1])
  if (assertions === undefined) return
  const child = (match[2] ?? "").trim()
  if (!child) return { tests: 1, assertions, failures: 0, skipped: 0 }
  if (/^<skipped\s*\/>$/.test(child)) return { tests: 1, assertions, failures: 0, skipped: 1 }
  const failure = child.match(/^<failure\b([^>]*)>[^<>]*<\/failure>$/)
  if (failure && validAttributes(failure[1])) return { tests: 1, assertions, failures: 1, skipped: 0 }
}

function readAssertions(attributes: string) {
  if (!validAttributes(attributes)) return
  const matches = [...attributes.matchAll(/\bassertions="(\d+)"/g)]
  if (matches.length !== 1) return
  const value = Schema.decodeUnknownOption(count)(Number(matches[0][1]))
  return value._tag === "Some" ? value.value : undefined
}

function validAttributes(attributes: string) {
  const pattern = /\s+([a-zA-Z][a-zA-Z0-9_-]*)="[^"<>]*"/g
  const names = [...attributes.matchAll(pattern)].map((match) => match[1])
  return attributes.replace(pattern, "").trim() === "" && names.length === new Set(names).size
}

export function validateVerifierReport(report: VerifierReport) {
  requireReportShape(report)
  const expected = decodedCounts(report.raw)
  if (report.digest !== (report.raw === null ? null : hash(report.raw)))
    throw new Error("Verifier report digest mismatch")
  if (encode(expected) !== encode(report.counts)) throw new Error("Verifier report counts mismatch")
  if ((report.state === "complete") !== (expected !== null)) throw new Error("Verifier report completion mismatch")
}

function requireReportShape(report: VerifierReport) {
  const absent = ["missing", "unsafe", "oversized"].includes(report.state)
  if (absent !== (report.raw === null)) throw new Error("Verifier report state/data mismatch")
  if (report.raw !== null && Buffer.byteLength(report.raw) > MAX_REPORT_BYTES)
    throw new Error("Verifier report exceeds byte budget")
}

function decodedCounts(raw: string | null) {
  return raw === null ? null : (parseJunit(raw) ?? null)
}
