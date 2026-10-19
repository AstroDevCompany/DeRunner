//! Shared usage thresholds. Mirrored by `src/lib/thresholds.ts`; keep in sync.
use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
#[repr(u8)]
pub enum Level {
    Normal,
    Warn,
    Critical,
}

pub const WARN_AT: f64 = 70.0;
pub const CRIT_ABOVE: f64 = 90.0;

/// normal < 70, warn 70..=90, critical > 90
pub fn level(pct: f64) -> Level {
    if pct > CRIT_ABOVE {
        Level::Critical
    } else if pct >= WARN_AT {
        Level::Warn
    } else {
        Level::Normal
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boundaries() {
        assert_eq!(level(0.0), Level::Normal);
        assert_eq!(level(69.99), Level::Normal);
        assert_eq!(level(70.0), Level::Warn);
        assert_eq!(level(90.0), Level::Warn);
        assert_eq!(level(90.01), Level::Critical);
        assert_eq!(level(250.0), Level::Critical);
    }
}
