"use client";

import { useEffect } from "react";
import { Trade } from "@/types/trade";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import {
  formatDetailDate,
  formatPrice,
  formatPercent,
  formatCurrency,
} from "@/utils/formatters";

interface TradeDetailModalProps {
  trade: Trade | null;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Round 54 fix #5: Validate that a screenshot URL is safe to render in <img src>.
 *
 * Threat model:
 *   - data:image with `;base64,` (and optional `;charset=utf-8;`) is safe.
 *   - blob: URLs are same-origin only.
 *   - http(s) URLs MUST match an allow-list. Loading an arbitrary external
 *     `https://attacker.com/x.png` would leak the user's IP + Referer to that
 *     server (and a previously-set RLS row could carry a malicious URL across
 *     tenants).
 *
 * Allowed HTTPS origins:
 *   - The configured Supabase storage host (NEXT_PUBLIC_SUPABASE_URL).
 *   - That's it. Add explicit hosts here if needed.
 *
 * `validateScreenshot` in storage.ts already filters on save — this is the
 * second line of defence at render-time.
 */
function isSafeScreenshotUrl(url: string): boolean {
  if (!url) return false;
  // data:image/<mime>(;charset=...)?;base64,<payload>
  if (
    /^data:image\/(png|jpe?g|webp|gif)(?:;charset=[\w-]+)?;base64,[A-Za-z0-9+/=]+$/i.test(
      url,
    )
  ) {
    return true;
  }
  if (url.startsWith("blob:")) return true;
  if (/^https:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      const supabaseHost = (() => {
        const env = process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (!env) return null;
        try {
          return new URL(env).host;
        } catch {
          return null;
        }
      })();
      if (supabaseHost && parsed.host === supabaseHost) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function formatHoldTime(entryDate: string, exitDate: string): string {
  const diffMs = new Date(exitDate).getTime() - new Date(entryDate).getTime();
  const totalMinutes = Math.floor(diffMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

export default function TradeDetailModal({
  trade,
  isOpen,
  onClose,
}: TradeDetailModalProps) {
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

  const focusTrapRef = useFocusTrap(isOpen);

  if (!isOpen || !trade) {
    return null;
  }

  const pnlColor = trade.pnl >= 0 ? "var(--profit)" : "var(--loss)";

  return (
    // Phase 60 (R45-UI-L2): close only when the user actually CLICKED the
    // overlay — not when a text-selection started inside the modal and
    // released on the overlay. `onMouseDown` capture on overlay paired
    // with `e.target === e.currentTarget` distinguishes the two.
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="trade-detail-title"
    >
      <div
        className="modal-content"
        ref={focusTrapRef}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="trade-detail-header">
          <span id="trade-detail-title" className="trade-detail-pair">
            {trade.pair}
          </span>
          <span className={`trade-detail-direction ${trade.direction}`}>
            {trade.direction === "long" ? "LONG" : "SHORT"}
          </span>
          <button
            className="trade-detail-close"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            &#10005;
          </button>
        </div>

        <div className="trade-detail-divider" />

        {/* Info Grid */}
        <div className="trade-detail-grid">
          {/* Row 1 */}
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Entry Price</span>
            <span className="trade-detail-item-value">
              ${formatPrice(trade.entryPrice)}
            </span>
          </div>
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Exit Price</span>
            <span className="trade-detail-item-value">
              ${formatPrice(trade.exitPrice)}
            </span>
          </div>
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Quantity</span>
            <span className="trade-detail-item-value">{trade.quantity}</span>
          </div>

          {/* Row 2 */}
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Entry Date</span>
            <span className="trade-detail-item-value">
              {formatDetailDate(trade.entryDate, { displayInUTC: true })}
            </span>
          </div>
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Exit Date</span>
            <span className="trade-detail-item-value">
              {formatDetailDate(trade.exitDate, { displayInUTC: true })}
            </span>
          </div>
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Hold Time</span>
            <span className="trade-detail-item-value">
              {formatHoldTime(trade.entryDate, trade.exitDate)}
            </span>
          </div>

          {/* Row 3 */}
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Leverage</span>
            <span className="trade-detail-item-value">
              {trade.leverage ?? 1}x
            </span>
          </div>
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Fees</span>
            <span className="trade-detail-item-value">
              ${formatPrice(trade.fees)}
            </span>
          </div>
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Strategy</span>
            <span className="trade-detail-item-value">
              {trade.strategy || "N/A"}
            </span>
          </div>
        </div>

        {/* Journal Entry Fields */}
        {(trade.emotion ||
          trade.confidence ||
          trade.setupType ||
          trade.timeframe ||
          trade.marketCondition) && (
          <>
            <div className="trade-detail-divider" />
            <div className="trade-detail-journal-title">Journal Entry</div>
            <div className="trade-detail-grid">
              {trade.emotion && (
                <div className="trade-detail-item">
                  <span className="trade-detail-item-label">Emotion</span>
                  <span className="trade-detail-item-value">
                    <span
                      className={`trade-detail-emotion trade-detail-emotion--${trade.emotion}`}
                    >
                      {trade.emotion === "confident" && "Confident"}
                      {trade.emotion === "neutral" && "Neutral"}
                      {trade.emotion === "fearful" && "Fearful"}
                      {trade.emotion === "greedy" && "Greedy"}
                      {trade.emotion === "fomo" && "FOMO"}
                      {trade.emotion === "revenge" && "Revenge"}
                    </span>
                  </span>
                </div>
              )}
              {trade.confidence && (
                <div className="trade-detail-item">
                  <span className="trade-detail-item-label">Confidence</span>
                  <span className="trade-detail-item-value">
                    <span className="trade-detail-confidence">
                      {[1, 2, 3, 4, 5].map((level) => (
                        <span
                          key={level}
                          className={`trade-detail-confidence-dot${level <= trade.confidence! ? " active" : ""}`}
                        />
                      ))}
                    </span>
                  </span>
                </div>
              )}
              {trade.setupType && (
                <div className="trade-detail-item">
                  <span className="trade-detail-item-label">Setup Type</span>
                  <span className="trade-detail-item-value">
                    {trade.setupType}
                  </span>
                </div>
              )}
              {trade.timeframe && (
                <div className="trade-detail-item">
                  <span className="trade-detail-item-label">Timeframe</span>
                  <span className="trade-detail-item-value">
                    {trade.timeframe}
                  </span>
                </div>
              )}
              {trade.marketCondition && (
                <div className="trade-detail-item">
                  <span className="trade-detail-item-label">
                    Market Condition
                  </span>
                  <span
                    className="trade-detail-item-value"
                    style={{ textTransform: "capitalize" }}
                  >
                    {trade.marketCondition}
                  </span>
                </div>
              )}
            </div>
          </>
        )}

        {/* PnL Hero */}
        <div className="trade-detail-pnl">
          <div className="trade-detail-pnl-value" style={{ color: pnlColor }}>
            {trade.pnl > 0 ? "+" : ""}
            {formatCurrency(trade.pnl)}
          </div>
          <div className="trade-detail-pnl-percent" style={{ color: pnlColor }}>
            {formatPercent(trade.pnlPercent)}
          </div>
        </div>

        {/* Tags */}
        {trade.tags && trade.tags.length > 0 && (
          <div className="trade-detail-tags">
            {trade.tags.map((tag, index) => (
              <span key={index} className="trade-detail-tag">
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Screenshot — Round 54 fix #5: tightened regex + origin allow-list
           in isSafeScreenshotUrl. External HTTPS images are blocked because
           they leak user IP + Referer to arbitrary servers. */}
        {trade.screenshot && isSafeScreenshotUrl(trade.screenshot) ? (
          <div className="trade-detail-screenshot">
            <div className="trade-detail-notes-label">Chart Screenshot</div>
            <img
              src={trade.screenshot}
              alt={`${trade.pair} trade chart`}
              referrerPolicy="no-referrer"
              style={{
                maxWidth: "100%",
                borderRadius: "8px",
                marginTop: "8px",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            />
          </div>
        ) : trade.screenshot ? (
          <div className="trade-detail-screenshot">
            <div className="trade-detail-notes-label">Chart Screenshot</div>
            <div
              style={{
                marginTop: "8px",
                padding: "12px",
                borderRadius: "8px",
                border: "1px dashed rgba(255,255,255,0.2)",
                color: "var(--txt-muted, #888)",
                fontSize: "0.875rem",
              }}
              role="status"
            >
              External image blocked
            </div>
          </div>
        ) : null}

        {/* Notes */}
        {trade.notes && (
          <div className="trade-detail-notes">
            <div className="trade-detail-notes-label">Notes</div>
            <div className="trade-detail-notes-text">{trade.notes}</div>
          </div>
        )}

        {/* Footer */}
        <div className="trade-detail-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
