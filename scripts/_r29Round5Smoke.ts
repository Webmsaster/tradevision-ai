import * as cfg from "../src/utils/ftmoDaytrade24h";

const NAMES = [
  "FTMO_DAYTRADE_24H_R28_V6_CVD",
  "FTMO_DAYTRADE_24H_R28_V6_CVD_SHORT",
  "FTMO_DAYTRADE_24H_R28_V6_CVD_LONG",
  "FTMO_DAYTRADE_24H_R28_V6_VOLIMB",
  "FTMO_DAYTRADE_24H_R28_V6_VOLIMB_LOOSE",
  "FTMO_DAYTRADE_24H_R28_V6_VOLIMB_STRICT",
  "FTMO_DAYTRADE_24H_R28_V6_POC",
  "FTMO_DAYTRADE_24H_R28_V6_POC_WIDE",
];
for (const n of NAMES) {
  const c = (cfg as Record<string, unknown>)[n] as
    | (typeof cfg)["FTMO_DAYTRADE_24H_R28_V6_PASSLOCK"]
    | undefined;
  if (!c) {
    console.log(`${n}: MISSING`);
    continue;
  }
  const a0 = c.assets[0]!;
  console.log(
    `${n}: assets=${c.assets.length} firstSym=${a0.symbol} cvd=${JSON.stringify(a0.cvdEntry ?? null)} volImb=${JSON.stringify(a0.volImbalanceEntry ?? null)} poc=${JSON.stringify(a0.volPocEntry ?? null)} closeAllOnTarget=${c.closeAllOnTargetReached ?? false}`,
  );
}
