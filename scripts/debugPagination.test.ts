import { describe, it } from "vitest";

describe("debug funding pagination", () => {
  it("raw pages", { timeout: 60_000 }, async () => {
    let endTime: number | undefined = undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL("https://fapi.binance.com/fapi/v1/fundingRate");
      url.searchParams.set("symbol", "BTCUSDT");
      url.searchParams.set("limit", "1000");
      if (endTime !== undefined)
        url.searchParams.set("endTime", String(endTime));
      const res = await fetch(url.toString());
      const rows: { fundingTime: number; fundingRate: string }[] =
        await res.json();
      if (!rows || rows.length === 0) {
        console.log(`page ${page}: EMPTY, stop`);
        break;
      }
      const first = new Date(rows[0].fundingTime).toISOString().slice(0, 10);
      const last = new Date(rows[rows.length - 1].fundingTime)
        .toISOString()
        .slice(0, 10);
      console.log(
        `page ${page}: ${rows.length} rows, first=${first} last=${last}, endTime=${endTime ? new Date(endTime).toISOString().slice(0, 10) : "-"}`,
      );
      endTime = rows[0].fundingTime - 1;
    }
  });
});
