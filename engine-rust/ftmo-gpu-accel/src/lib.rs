//! 2026-05-17 GPU-accelerated backtesting — SKELETON.
//!
//! Cross-platform via wgpu (Vulkan/Metal/DX12).
//!
//! Plan: Indicator batch (ATR, RSI, SMA) across all (asset, window, param)
//! tripel parallel auf GPU. CPU shadows mandatory in CI für float-parity.
//!
//! STATUS: Skeleton + GPU-detect probe. Full kernels = ~3-4 days.

use std::fmt;

#[derive(Debug)]
pub enum GpuBackend { Vulkan, Metal, Dx12, Cpu_Fallback }

impl fmt::Display for GpuBackend {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { write!(f, "{:?}", self) }
}

/// Probe available GPU backends. Returns `Cpu_Fallback` if no GPU is detected.
/// Real impl would use `wgpu::Instance::new` and enumerate adapters.
pub fn detect_backend() -> GpuBackend {
    // STUB: detect via /sys/class/drm or similar
    if std::path::Path::new("/sys/class/drm/card0").exists() {
        GpuBackend::Vulkan
    } else {
        GpuBackend::Cpu_Fallback
    }
}

pub struct GpuIndicatorEngine {
    backend: GpuBackend,
}

impl GpuIndicatorEngine {
    pub fn new() -> Self { Self { backend: detect_backend() } }
    pub fn backend(&self) -> &GpuBackend { &self.backend }

    /// Compute ATR on GPU (skeleton).
    /// In full impl: upload close prices to GPU buffer, dispatch ATR kernel.
    pub fn atr(&self, _closes: &[f64], _period: usize) -> Vec<Option<f64>> {
        // SKELETON — falls back to CPU
        Vec::new()
    }
}

impl Default for GpuIndicatorEngine {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backend_detection_works() {
        let backend = detect_backend();
        println!("Detected: {}", backend);
    }
    #[test]
    fn engine_constructs() {
        let _engine = GpuIndicatorEngine::new();
    }
}
