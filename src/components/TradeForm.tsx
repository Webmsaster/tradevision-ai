"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { Trade } from "@/types/trade";
import { calculatePnl, validateLeverage } from "@/utils/calculations";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { FILE_SIZE } from "@/lib/constants";

interface TradeFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (trade: Trade) => void;
  editTrade?: Trade | null;
}

/**
 * Convert an ISO (UTC) date string to the `YYYY-MM-DDTHH:mm` format expected
 * by datetime-local inputs. Round 56 fix #4: render UTC fields so the input
 * shows the same wall-clock value that aiAnalysis / WeeklySummary /
 * DayOfWeekHeatmap aggregate on. A small "Times stored as UTC" hint near
 * the inputs tells the user explicitly.
 */
function toDatetimeLocal(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  // Phase 33 (React Audit Bug 4): guard against Invalid Date — was rendering
  // 'NaN-NaN-NaNTNaN:NaN' in the form when entryDate was empty/corrupt.
  if (isNaN(date.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/**
 * Convert a `YYYY-MM-DDTHH:mm` value from a datetime-local input back to an
 * ISO string. Round 56 fix #4: treat the input as UTC (since the displayed
 * value is UTC by toDatetimeLocal above) by appending `Z`. Falls back to
 * normalizeDateToUTC's naive-coercion path for safety.
 */
function fromDatetimeLocal(value: string): string {
  if (!value) return "";
  // The input format is `YYYY-MM-DDTHH:mm` — treat as UTC explicitly.
  const utcCandidate = `${value}:00Z`;
  const d = new Date(utcCandidate);
  if (isNaN(d.getTime())) return "";
  return d.toISOString();
}

export default function TradeForm({
  isOpen,
  onClose,
  onSubmit,
  editTrade,
}: TradeFormProps) {
  // ---- form state ----
  const [pair, setPair] = useState("");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [entryPrice, setEntryPrice] = useState("");
  const [exitPrice, setExitPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [leverage, setLeverage] = useState("1");
  const [fees, setFees] = useState("0");
  const [entryDate, setEntryDate] = useState("");
  const [exitDate, setExitDate] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [strategy, setStrategy] = useState("");
  const [emotion, setEmotion] = useState<Trade["emotion"] | "">("");
  const [confidence, setConfidence] = useState<number>(0);
  const [setupType, setSetupType] = useState("");
  const [timeframe, setTimeframe] = useState("");
  const [marketCondition, setMarketCondition] = useState<
    Trade["marketCondition"] | ""
  >("");
  const [screenshot, setScreenshot] = useState<string>("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Round 54 fix #4: prevent double-submit (double-click creates two trades).
  const [submitting, setSubmitting] = useState(false);
  // Round 54 fix #3: cancel-flag for in-flight image-decoding so rapid file
  // selections + unmount don't race on setScreenshot/revoke.
  const imageLoadCancelRef = useRef<{ cancelled: boolean } | null>(null);

  // ---- populate fields when editing ----
  // Round 54 fix: deps reduced to [editTrade?.id, isOpen] — re-init only when actually
  // switching trades or open/close. Parent re-renders that pass a new editTrade object
  // identity (e.g. via spread) no longer obliterate user input.

  useEffect(() => {
    if (editTrade) {
      setPair(editTrade.pair);
      setDirection(editTrade.direction);
      setEntryPrice(String(editTrade.entryPrice));
      setExitPrice(String(editTrade.exitPrice));
      setQuantity(String(editTrade.quantity));
      setLeverage(String(editTrade.leverage));
      setFees(String(editTrade.fees));
      setEntryDate(toDatetimeLocal(editTrade.entryDate));
      setExitDate(toDatetimeLocal(editTrade.exitDate));
      setNotes(editTrade.notes);
      setTags(editTrade.tags.join(", "));
      setStrategy(editTrade.strategy ?? "");
      setEmotion(editTrade.emotion ?? "");
      setConfidence(editTrade.confidence ?? 0);
      setSetupType(editTrade.setupType ?? "");
      setTimeframe(editTrade.timeframe ?? "");
      setMarketCondition(editTrade.marketCondition ?? "");
      // Round-N UX: allowlist data-URL prefix on edit-restore. Older trades or
      // hand-edited DB rows might carry SVG/HTML data-URLs — drop them silently
      // so the <img> never tries to render an unsanitized payload.
      const restored = editTrade.screenshot ?? "";
      const allowed = /^data:image\/(png|jpeg|webp);base64,/;
      setScreenshot(allowed.test(restored) ? restored : "");
    } else {
      resetForm();
    }
  }, [editTrade?.id, isOpen]);

  // Escape key and body scroll lock
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleEscape);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [isOpen, onClose]);

  // Round 54 fix #3: cancel any pending image-decode on unmount.
  useEffect(() => {
    return () => {
      if (imageLoadCancelRef.current) {
        imageLoadCancelRef.current.cancelled = true;
      }
    };
  }, []);

  function resetForm() {
    setPair("");
    setDirection("long");
    setEntryPrice("");
    setExitPrice("");
    setQuantity("");
    setLeverage("1");
    setFees("0");
    setEntryDate("");
    setExitDate("");
    setNotes("");
    setTags("");
    setStrategy("");
    setEmotion("");
    setConfidence(0);
    setSetupType("");
    setTimeframe("");
    setMarketCondition("");
    setScreenshot("");
    setErrors({});
  }

  // ---- live PnL preview ----
  const pnlPreview = useMemo(() => {
    const ep = parseFloat(entryPrice);
    const xp = parseFloat(exitPrice);
    const qty = parseFloat(quantity);
    const lev = parseFloat(leverage);
    const f = parseFloat(fees);

    if (isNaN(ep) || isNaN(xp) || isNaN(qty) || ep <= 0 || qty <= 0) {
      return null;
    }

    const result = calculatePnl({
      pair,
      direction,
      entryPrice: ep,
      exitPrice: xp,
      quantity: qty,
      leverage: isNaN(lev) || lev <= 0 ? 1 : lev,
      fees: isNaN(f) ? 0 : f,
      entryDate: "",
      exitDate: "",
      notes: "",
      tags: [],
    });

    return result;
  }, [entryPrice, exitPrice, quantity, leverage, fees, direction, pair]);

  // ---- validation ----
  function validate(): boolean {
    const newErrors: Record<string, string> = {};

    if (!pair.trim()) newErrors.pair = "Pair is required";
    if (
      !entryPrice ||
      isNaN(parseFloat(entryPrice)) ||
      parseFloat(entryPrice) <= 0
    )
      newErrors.entryPrice = "Valid entry price is required";
    if (
      !exitPrice ||
      isNaN(parseFloat(exitPrice)) ||
      parseFloat(exitPrice) <= 0
    )
      newErrors.exitPrice = "Valid exit price is required";
    // R8: guard against Infinity / NaN / absurd magnitudes (1e12 cap).
    const qtyNum = parseFloat(quantity);
    if (!quantity || !Number.isFinite(qtyNum) || qtyNum <= 0 || qtyNum > 1e12)
      newErrors.quantity = "Valid quantity is required";
    const epNum = parseFloat(entryPrice);
    if (entryPrice && (!Number.isFinite(epNum) || epNum <= 0 || epNum > 1e12)) {
      newErrors.entryPrice = "Valid entry price is required";
    }
    const xpNum = parseFloat(exitPrice);
    if (exitPrice && (!Number.isFinite(xpNum) || xpNum <= 0 || xpNum > 1e12)) {
      newErrors.exitPrice = "Valid exit price is required";
    }
    const feesNum = parseFloat(fees);
    if (fees && (!Number.isFinite(feesNum) || feesNum < 0 || feesNum > 1e9)) {
      newErrors.fees = "Valid fees value required";
    }
    // R8 Task B: validateLeverage on submit — flag fallback if user typed
    // something unparseable (Infinity, NaN, negative, 0).
    if (leverage !== "") {
      const { fallback } = validateLeverage(parseFloat(leverage));
      if (fallback) newErrors.leverage = "Invalid leverage value";
    }
    if (!entryDate) newErrors.entryDate = "Entry date is required";
    if (!exitDate) newErrors.exitDate = "Exit date is required";
    // Round 60 audit fix: append `:00Z` to force UTC interpretation —
    // `<input type="datetime-local">` produces strings without TZ which
    // `new Date()` parses as LOCAL. With storage in UTC this caused
    // false-positive "exit < entry" validation for trades crossing UTC
    // midnight in CEST/CET (Florian's TZ).
    if (
      entryDate &&
      exitDate &&
      new Date(`${exitDate}:00Z`) < new Date(`${entryDate}:00Z`)
    ) {
      newErrors.exitDate = "Exit date must be after entry date";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  // ---- submit ----
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Round 54 fix #4: hard-block double-submit (rapid double-click).
    if (submitting) return;
    if (!validate()) return;
    setSubmitting(true);

    try {
      const ep = parseFloat(entryPrice);
      const xp = parseFloat(exitPrice);
      const qty = parseFloat(quantity);
      const lev = parseFloat(leverage) || 1;
      const f = parseFloat(fees) || 0;
      // R8 Task A: cap individual tag length (50) and total count (20) so
      // pathological imports/pasted data can't blow up the trade record.
      const parsedTags = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .filter((t) => t.length <= 50)
        .slice(0, 20);

      const tradeBase = {
        pair: pair.trim(),
        direction,
        entryPrice: ep,
        exitPrice: xp,
        quantity: qty,
        leverage: lev,
        fees: f,
        entryDate: fromDatetimeLocal(entryDate),
        exitDate: fromDatetimeLocal(exitDate),
        notes: notes.trim(),
        tags: parsedTags,
        strategy: strategy.trim() || undefined,
        emotion: emotion || undefined,
        confidence: confidence > 0 ? confidence : undefined,
        setupType: setupType.trim() || undefined,
        timeframe: timeframe || undefined,
        marketCondition: marketCondition || undefined,
        screenshot: screenshot || undefined,
      };

      const { pnl, pnlPercent } = calculatePnl(
        tradeBase as Omit<Trade, "id" | "pnl" | "pnlPercent">,
      );

      const trade: Trade = {
        ...tradeBase,
        id: editTrade ? editTrade.id : crypto.randomUUID(),
        pnl,
        pnlPercent,
      } as Trade;

      onSubmit(trade);
      resetForm();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  const focusTrapRef = useFocusTrap(isOpen);

  // ---- render ----
  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="trade-form-title"
    >
      <div
        className="modal-content"
        ref={focusTrapRef}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="trade-form-header">
          <h2 id="trade-form-title" className="trade-form-title">
            {editTrade ? "Edit Trade" : "Add New Trade"}
          </h2>
          <button
            className="trade-form-close"
            onClick={onClose}
            aria-label="Close"
          >
            &#x2715;
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="trade-form-grid">
            {/* Pair */}
            <div className="form-group trade-form-full">
              <label className="form-label">
                Pair *
                <input
                  type="text"
                  className={`form-input${errors.pair ? " error" : ""}`}
                  placeholder="BTC/USDT"
                  value={pair}
                  onChange={(e) => setPair(e.target.value)}
                />
              </label>
              {errors.pair && <span className="form-error">{errors.pair}</span>}
            </div>

            {/* Direction */}
            <div className="form-group">
              <label className="form-label">
                Direction *
                <select
                  className="form-input"
                  value={direction}
                  onChange={(e) =>
                    setDirection(e.target.value as "long" | "short")
                  }
                >
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </select>
              </label>
            </div>

            {/* Leverage */}
            <div className="form-group">
              <label className="form-label">
                Leverage
                <input
                  type="number"
                  className={`form-input${errors.leverage ? " error" : ""}`}
                  placeholder="1"
                  min="1"
                  step="1"
                  value={leverage}
                  onChange={(e) => setLeverage(e.target.value)}
                />
              </label>
              {errors.leverage && (
                <span className="form-error">{errors.leverage}</span>
              )}
            </div>

            {/* Entry Price */}
            <div className="form-group">
              <label className="form-label">
                Entry Price *
                <input
                  type="number"
                  className={`form-input${errors.entryPrice ? " error" : ""}`}
                  placeholder="0.00"
                  min="0"
                  step="any"
                  value={entryPrice}
                  onChange={(e) => setEntryPrice(e.target.value)}
                />
              </label>
              {errors.entryPrice && (
                <span className="form-error">{errors.entryPrice}</span>
              )}
            </div>

            {/* Exit Price */}
            <div className="form-group">
              <label className="form-label">
                Exit Price *
                <input
                  type="number"
                  className={`form-input${errors.exitPrice ? " error" : ""}`}
                  placeholder="0.00"
                  min="0"
                  step="any"
                  value={exitPrice}
                  onChange={(e) => setExitPrice(e.target.value)}
                />
              </label>
              {errors.exitPrice && (
                <span className="form-error">{errors.exitPrice}</span>
              )}
            </div>

            {/* Quantity */}
            <div className="form-group">
              <label className="form-label">
                Quantity *
                <input
                  type="number"
                  className={`form-input${errors.quantity ? " error" : ""}`}
                  placeholder="0.00"
                  min="0"
                  step="any"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </label>
              {errors.quantity && (
                <span className="form-error">{errors.quantity}</span>
              )}
            </div>

            {/* Fees */}
            <div className="form-group">
              <label className="form-label">
                Fees
                <input
                  type="number"
                  className="form-input"
                  placeholder="0.00"
                  min="0"
                  step="any"
                  value={fees}
                  onChange={(e) => setFees(e.target.value)}
                />
              </label>
            </div>

            {/* Entry Date */}
            <div className="form-group">
              <label className="form-label">
                Entry Date * (UTC)
                <input
                  type="datetime-local"
                  className={`form-input${errors.entryDate ? " error" : ""}`}
                  value={entryDate}
                  onChange={(e) => setEntryDate(e.target.value)}
                />
              </label>
              {errors.entryDate && (
                <span className="form-error">{errors.entryDate}</span>
              )}
            </div>

            {/* Exit Date */}
            <div className="form-group">
              <label className="form-label">
                Exit Date * (UTC)
                <input
                  type="datetime-local"
                  className={`form-input${errors.exitDate ? " error" : ""}`}
                  value={exitDate}
                  onChange={(e) => setExitDate(e.target.value)}
                />
              </label>
              {errors.exitDate && (
                <span className="form-error">{errors.exitDate}</span>
              )}
            </div>
            {/* Round 56 fix #4: explicit UTC hint so users know the
                datetime-local input does NOT use their browser TZ. */}
            <div
              className="trade-form-full"
              style={{
                fontSize: "11px",
                color: "var(--text-secondary)",
                marginTop: "-4px",
              }}
            >
              Times are stored and displayed in UTC.
            </div>

            {/* Strategy */}
            <div className="form-group trade-form-full">
              <label className="form-label">
                Strategy
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. Breakout, Mean Reversion..."
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value)}
                />
              </label>
            </div>

            {/* Tags */}
            <div className="form-group trade-form-full">
              <label className="form-label">
                Tags
                <input
                  type="text"
                  className="form-input"
                  placeholder="Comma separated, e.g. scalp, news, momentum"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  maxLength={500}
                />
              </label>
            </div>

            {/* Notes */}
            <div className="form-group trade-form-full">
              <label className="form-label">
                Notes
                <textarea
                  className="form-input"
                  rows={3}
                  placeholder="Trade rationale, observations..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
            </div>

            {/* Journal Entry Section */}
            <div className="trade-form-full">
              <div className="trade-form-section-title">Journal Entry</div>
            </div>

            {/* Emotion */}
            <div className="form-group">
              <label className="form-label">
                Emotion
                <select
                  className="form-input"
                  value={emotion}
                  onChange={(e) =>
                    setEmotion(e.target.value as Trade["emotion"] | "")
                  }
                >
                  <option value="">Select emotion...</option>
                  <option value="confident">Confident</option>
                  <option value="neutral">Neutral</option>
                  <option value="fearful">Fearful</option>
                  <option value="greedy">Greedy</option>
                  <option value="fomo">FOMO</option>
                  <option value="revenge">Revenge</option>
                </select>
              </label>
            </div>

            {/* Confidence */}
            <div className="form-group">
              {/* Round 58 a11y: confidence is a button-group, label exposed
                  via aria-labelledby on the role=group container. */}
              <span className="form-label" id="confidence-label">
                Confidence
              </span>
              <div
                className="trade-form-confidence"
                role="group"
                aria-labelledby="confidence-label"
              >
                {[1, 2, 3, 4, 5].map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={`confidence-dot${level <= confidence ? " active" : ""}`}
                    onClick={() =>
                      setConfidence(level === confidence ? 0 : level)
                    }
                    title={`Confidence: ${level}/5`}
                    aria-label={`Confidence level ${level} of 5`}
                    aria-pressed={level <= confidence}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>

            {/* Setup Type */}
            <div className="form-group">
              <label className="form-label">
                Setup Type
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. breakout, pullback..."
                  list="setup-type-suggestions"
                  value={setupType}
                  onChange={(e) => setSetupType(e.target.value)}
                />
              </label>
              <datalist id="setup-type-suggestions">
                <option value="breakout" />
                <option value="pullback" />
                <option value="reversal" />
                <option value="range-trade" />
                <option value="trend-follow" />
                <option value="scalp" />
                <option value="swing" />
                <option value="news-trade" />
              </datalist>
            </div>

            {/* Timeframe */}
            <div className="form-group">
              <label className="form-label">
                Timeframe
                <select
                  className="form-input"
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value)}
                >
                  <option value="">Select timeframe...</option>
                  <option value="1m">1m</option>
                  <option value="5m">5m</option>
                  <option value="15m">15m</option>
                  <option value="30m">30m</option>
                  <option value="1h">1h</option>
                  <option value="4h">4h</option>
                  <option value="1d">1d</option>
                  <option value="1w">1w</option>
                </select>
              </label>
            </div>

            {/* Market Condition */}
            <div className="form-group trade-form-full">
              <label className="form-label">
                Market Condition
                <select
                  className="form-input"
                  value={marketCondition}
                  onChange={(e) =>
                    setMarketCondition(
                      e.target.value as Trade["marketCondition"] | "",
                    )
                  }
                >
                  <option value="">Select condition...</option>
                  <option value="trending">Trending</option>
                  <option value="ranging">Ranging</option>
                  <option value="volatile">Volatile</option>
                  <option value="calm">Calm</option>
                </select>
              </label>
            </div>
            {/* Screenshot Upload */}
            <div className="form-group trade-form-full">
              <span className="form-label">Chart Screenshot</span>
              {screenshot ? (
                <div style={{ position: "relative", marginBottom: "8px" }}>
                  <img
                    src={screenshot}
                    alt="Trade screenshot"
                    style={{
                      maxWidth: "100%",
                      maxHeight: "200px",
                      borderRadius: "8px",
                      border: "1px solid rgba(255,255,255,0.1)",
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ position: "absolute", top: "4px", right: "4px" }}
                    onClick={() => setScreenshot("")}
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="form-input"
                  aria-label="Chart screenshot"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    // Phase 44 (R44-UI-3-mid): reject SVG explicitly. Browser
                    // parses SVG-DOM during img.onload (no script-execution,
                    // but unwanted DOM cost), and our re-encode-to-JPEG path
                    // disarms scripts only after parse. Cheap to block.
                    const ALLOWED_MIME = [
                      "image/png",
                      "image/jpeg",
                      "image/webp",
                    ];
                    if (!ALLOWED_MIME.includes(file.type)) {
                      setErrors((prev) => ({
                        ...prev,
                        screenshot: "Only PNG/JPEG/WebP images are supported",
                      }));
                      return;
                    }
                    if (file.size > FILE_SIZE.IMAGE_UPLOAD_MAX) {
                      setErrors((prev) => ({
                        ...prev,
                        screenshot: "Image must be under 5 MB",
                      }));
                      return;
                    }
                    setErrors((prev) => {
                      const { screenshot: _, ...rest } = prev;
                      return rest;
                    });
                    // Round 54 fix #3: cancel any in-flight previous decode so
                    // rapid file selections don't race (slower onload winning
                    // over faster). Each selection installs a fresh token; the
                    // unmount-effect also flips cancelled=true.
                    if (imageLoadCancelRef.current) {
                      imageLoadCancelRef.current.cancelled = true;
                    }
                    const token = { cancelled: false };
                    imageLoadCancelRef.current = token;
                    // Phase 44 (R44-UI-1): hold the ObjectURL in a separate
                    // variable so onload AND onerror revoke the same URL.
                    const objectUrl = URL.createObjectURL(file);
                    const img = new Image();
                    img.onload = () => {
                      try {
                        if (token.cancelled) return;
                        // Phase 85 (R51-UI-1): clamp BOTH dimensions.
                        // Round 56 (R56-STO-1): tighten compression
                        // (800x800 q=0.6 → 600x600 q=0.5). Each screenshot
                        // shrinks ~55%; with localStorage's 5 MB quota a
                        // user can now keep ~30+ screenshots before
                        // QuotaExceededError fires.
                        const MAX_WIDTH = 600;
                        const MAX_HEIGHT = 600;
                        const scale = Math.min(
                          1,
                          MAX_WIDTH / img.width,
                          MAX_HEIGHT / img.height,
                        );
                        const canvas = document.createElement("canvas");
                        canvas.width = Math.round(img.width * scale);
                        canvas.height = Math.round(img.height * scale);
                        const ctx = canvas.getContext("2d");
                        if (ctx) {
                          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                          const compressed = canvas.toDataURL(
                            "image/jpeg",
                            0.5,
                          );
                          if (!token.cancelled) setScreenshot(compressed);
                        }
                      } finally {
                        URL.revokeObjectURL(objectUrl);
                      }
                    };
                    img.onerror = () => {
                      URL.revokeObjectURL(objectUrl);
                      if (token.cancelled) return;
                      setErrors((prev) => ({
                        ...prev,
                        screenshot: "Could not decode image",
                      }));
                    };
                    img.src = objectUrl;
                  }}
                />
              )}
              {errors.screenshot && (
                <span className="form-error">{errors.screenshot}</span>
              )}
            </div>
          </div>

          {/* Live PnL Preview */}
          {pnlPreview !== null && (
            <div className="trade-form-pnl-preview">
              <div className="trade-form-pnl-label">Estimated PnL</div>
              <div
                className="trade-form-pnl-value"
                style={{
                  color: pnlPreview.pnl >= 0 ? "var(--profit)" : "var(--loss)",
                }}
              >
                {pnlPreview.pnl >= 0 ? "+" : ""}
                {pnlPreview.pnl.toFixed(2)} (
                {pnlPreview.pnlPercent >= 0 ? "+" : ""}
                {pnlPreview.pnlPercent.toFixed(2)}%)
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="trade-form-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting}
              aria-busy={submitting}
            >
              {submitting
                ? editTrade
                  ? "Updating..."
                  : "Adding..."
                : editTrade
                  ? "Update Trade"
                  : "Add Trade"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
