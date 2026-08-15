use std::time::SystemTime;

pub fn derive(last_activity: SystemTime, now: SystemTime) -> &'static str {
    match now.duration_since(last_activity) {
        Err(_) => "active",
        Ok(d) if d.as_secs() < 30 => "active",
        Ok(d) if d.as_secs() < 600 => "idle",
        Ok(_) => "stale",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn thresholds() {
        let t0 = UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert_eq!(derive(t0, t0 + Duration::from_secs(5)), "active");
        assert_eq!(derive(t0, t0 + Duration::from_secs(29)), "active");
        assert_eq!(derive(t0, t0 + Duration::from_secs(31)), "idle");
        assert_eq!(derive(t0, t0 + Duration::from_secs(599)), "idle");
        assert_eq!(derive(t0, t0 + Duration::from_secs(601)), "stale");
        assert_eq!(derive(t0 + Duration::from_secs(10), t0), "active"); // clock skew → safe default
    }
}
