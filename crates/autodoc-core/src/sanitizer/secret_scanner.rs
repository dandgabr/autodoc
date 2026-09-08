use regex::Regex;
use crate::sanitizer::entropy::{correlation_hash, shannon_entropy};

pub struct SecretPattern {
    pub name: String,
    pub pattern: Regex,
    pub min_entropy: f64,
    pub label: String,
}

pub struct SecretScanner {
    patterns: Vec<SecretPattern>,
}

impl Default for SecretScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretScanner {
    pub fn new() -> Self {
        let mut scanner = Self { patterns: Vec::new() };
        scanner.register_defaults();
        scanner
    }

    fn register_defaults(&mut self) {
        // AWS Access Key ID
        self.add_pattern("AWS_Access_Key", r"\bAKIA[0-9A-Z]{16}\b", 0.0, "AWS_KEY");

        // AWS Secret Key (40 chars base64, high entropy)
        self.add_pattern(
            "AWS_Secret_Key",
            r#"(?i)aws_secret_access_key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?"#,
            4.5,
            "AWS_SECRET",
        );

        // OpenAI API Key
        self.add_pattern("OpenAI_API_Key", r"\bsk-[a-zA-Z0-9]{48,}\b", 4.0, "OPENAI_KEY");

        // Anthropic API Key
        self.add_pattern("Anthropic_API_Key", r"\bsk-ant-api03-[a-zA-Z0-9_\-]{80,}\b", 4.0, "ANTHROPIC_KEY");

        // GitHub Token (ghp_, gho_, etc.)
        self.add_pattern("GitHub_Token", r"\bgh[pousr]-[A-Za-z0-9_]{36,}\b", 4.0, "GITHUB_TOKEN");

        // Generic Private Key Headers
        self.add_pattern(
            "PrivateKeyHeader",
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
            0.0,
            "PRIVATE_KEY",
        );

        // JWT Token (3 base64url parts separated by dots)
        self.add_pattern(
            "JWT_Token",
            r"\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b",
            4.0,
            "JWT_TOKEN",
        );

        // Generic Database Password / URI Credentials
        self.add_pattern(
            "DatabaseURIWithPassword",
            r"(?i)(?:postgres|mysql|mongodb|redis|amqp)://[^:]+:([^@]+)@",
            0.0,
            "DB_PASSWORD",
        );
    }

    pub fn add_pattern(&mut self, name: &str, regex_str: &str, min_entropy: f64, label: &str) {
        if let Ok(re) = Regex::new(regex_str) {
            self.patterns.push(SecretPattern {
                name: name.to_string(),
                pattern: re,
                min_entropy,
                label: label.to_string(),
            });
        }
    }

    /// Redacts all detected secrets from input text.
    pub fn redact_secrets(&self, input: &str) -> String {
        let mut output = input.to_string();

        for pat in &self.patterns {
            output = pat.pattern.replace_all(&output, |caps: &regex::Captures| {
                let secret_val = if caps.len() > 1 {
                    caps.get(1).map(|m| m.as_str()).unwrap_or("")
                } else {
                    caps.get(0).map(|m| m.as_str()).unwrap_or("")
                };

                if pat.min_entropy > 0.0 {
                    let entropy = shannon_entropy(secret_val);
                    if entropy < pat.min_entropy {
                        // Entropy is too low, likely placeholder or false positive
                        return caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string();
                    }
                }

                let hash = correlation_hash(secret_val);
                let placeholder = format!("[REDACTED_{}:{}]", pat.label, hash);

                if caps.len() > 1 {
                    // Replace only the captured secret portion within the matched string
                    let full_match = caps.get(0).map(|m| m.as_str()).unwrap_or("");
                    full_match.replace(secret_val, &placeholder)
                } else {
                    placeholder
                }
            }).to_string();
        }

        output
    }
}
