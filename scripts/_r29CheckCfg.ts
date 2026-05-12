import * as m from "../src/utils/ftmoDaytrade24h";
const c = (m as Record<string, any>)[
  process.argv[2] ?? "FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_PLUS"
];
if (!c) {
  console.log("not found");
  process.exit(1);
}
console.log(
  "n=",
  c.assets.length,
  "syms=",
  [
    ...new Set(c.assets.map((a: { sourceSymbol: string }) => a.sourceSymbol)),
  ].join(","),
  "tf=",
  c.timeframe,
  "maxDays=",
  c.maxDays,
  "liveCaps=",
  JSON.stringify(c.liveCaps),
);
