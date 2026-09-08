use autodoc_core::sanitizer::{SanitizerEngine, shannon_entropy};

#[test]
fn test_aws_key_redaction() {
    let engine = SanitizerEngine::new();
    let sample = "let aws_key = \"AKIA1234567890ABCDEF\";";
    let redacted = engine.sanitize(sample);

    assert!(!redacted.contains("AKIA1234567890ABCDEF"));
    assert!(redacted.contains("[REDACTED_AWS_KEY:"));
}

#[test]
fn test_jwt_token_redaction() {
    let engine = SanitizerEngine::new();
    let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    let sample = format!("Authorization: Bearer {}", jwt);
    let redacted = engine.sanitize(&sample);

    assert!(!redacted.contains(jwt));
    assert!(redacted.contains("[REDACTED_JWT_TOKEN:"));
}

#[test]
fn test_database_password_redaction() {
    let engine = SanitizerEngine::new();
    let uri = "postgres://admin:SuperSecretP@ss123@db.internal:5432/production";
    let redacted = engine.sanitize(uri);

    assert!(!redacted.contains("SuperSecretP@ss123"));
    assert!(redacted.contains("[REDACTED_DB_PASSWORD:"));
}

#[test]
fn test_brazil_cpf_modulo_11_redaction() {
    let engine = SanitizerEngine::new();
    // Valid generated CPF: 529.982.247-25
    let valid_cpf = "529.982.247-25";
    let sample = format!("User CPF is {}", valid_cpf);
    let redacted = engine.sanitize(&sample);

    assert!(!redacted.contains(valid_cpf));
    assert!(redacted.contains("[REDACTED_CPF:"));

    // Invalid CPF should NOT be redacted
    let invalid_cpf = "111.111.111-11";
    let invalid_sample = format!("Testing invalid: {}", invalid_cpf);
    let not_redacted = engine.sanitize(&invalid_sample);
    assert!(not_redacted.contains(invalid_cpf));
}

#[test]
fn test_credit_card_luhn_redaction() {
    let engine = SanitizerEngine::new();
    // Standard Luhn valid Visa test card
    let valid_card = "4532-7913-5402-8840";
    let sample = format!("Payment card: {}", valid_card);
    let redacted = engine.sanitize(&sample);

    assert!(!redacted.contains(valid_card));
    assert!(redacted.contains("[REDACTED_CREDIT_CARD:"));
}

#[test]
fn test_shannon_entropy_calculation() {
    let low_entropy = "AAAAAAAAAA";
    let high_entropy = "aB3$kL9#mP0!xQ7&";

    assert!(shannon_entropy(low_entropy) < 1.0);
    assert!(shannon_entropy(high_entropy) >= 3.5);
}
