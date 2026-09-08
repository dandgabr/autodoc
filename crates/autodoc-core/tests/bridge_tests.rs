use autodoc_core::{ping, trigger_panic_test};

#[test]
fn test_ping_success() {
    let trace_id = "test-trace-uuid-1234".to_string();
    let res = ping(trace_id.clone()).expect("Ping should succeed");
    assert_eq!(res.trace_id, trace_id);
    assert_eq!(res.status, "OK");
    assert_eq!(res.version, "0.1.0");
    assert!(res.timestamp_ms > 0);
}

#[test]
fn test_panic_interception() {
    let result = trigger_panic_test("Intentional test fault".to_string());
    assert!(result.is_err(), "Triggered panic should be converted to an Err result");
    let err_str = result.unwrap_err().to_string();
    assert!(err_str.contains("AUTODOC_E401"));
    assert!(err_str.contains("Intentional test fault"));
}
