use regex::Regex;
use serde::{Deserialize, Serialize};
use crate::sanitizer::entropy::correlation_hash;
use crate::sanitizer::validators::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PiiCategory {
    General,
    Latam,
    Europe,
    HealthTech,
    Industrial,
    FinTech,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChecksumKind {
    None,
    Cpf,
    Cnpj,
    Ssn,
    Luhn,
    Cns,
}

pub struct PiiDefinition {
    pub name: String,
    pub category: PiiCategory,
    pub pattern: Regex,
    pub checksum: ChecksumKind,
    pub label: String,
}

pub struct PiiRegistry {
    rules: Vec<PiiDefinition>,
}

impl Default for PiiRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl PiiRegistry {
    pub fn new() -> Self {
        let mut registry = Self { rules: Vec::new() };
        registry.register_defaults();
        registry
    }

    fn register_defaults(&mut self) {
        // 1. General & Digital
        self.add_rule(
            "Email",
            PiiCategory::General,
            r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+",
            ChecksumKind::None,
            "EMAIL",
        );
        self.add_rule(
            "InternationalPhone",
            PiiCategory::General,
            r"\+[1-9]\d{1,14}\b",
            ChecksumKind::None,
            "PHONE",
        );
        self.add_rule(
            "IPv4Public",
            PiiCategory::General,
            r"\b(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){3}\b",
            ChecksumKind::None,
            "IP_ADDR",
        );
        self.add_rule(
            "AuthorAnnotation",
            PiiCategory::General,
            r"@author\s+[\w\.\-]+(?:\s+<[^>]+>)?",
            ChecksumKind::None,
            "AUTHOR",
        );

        // 2. LATAM
        self.add_rule(
            "BrazilCPF",
            PiiCategory::Latam,
            r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b",
            ChecksumKind::Cpf,
            "CPF",
        );
        self.add_rule(
            "BrazilCNPJ",
            PiiCategory::Latam,
            r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b",
            ChecksumKind::Cnpj,
            "CNPJ",
        );

        // 3. USA & Europe
        self.add_rule(
            "US_SSN",
            PiiCategory::Europe,
            r"\b\d{3}-\d{2}-\d{4}\b",
            ChecksumKind::Ssn,
            "SSN",
        );

        // 4. FinTech
        self.add_rule(
            "CreditCardPAN",
            PiiCategory::FinTech,
            r"\b(?:\d{4}[ -]?){3,4}\d{1,4}\b",
            ChecksumKind::Luhn,
            "CREDIT_CARD",
        );

        // 5. HealthTech
        self.add_rule(
            "BrazilCNS",
            PiiCategory::HealthTech,
            r"\b[12789]\d{2}\.?\d{4}\.?\d{4}\.?\d{4}\b",
            ChecksumKind::Cns,
            "HEALTH_ID",
        );

        // 6. Industrial & Hardware
        self.add_rule(
            "MAC_Address",
            PiiCategory::Industrial,
            r"\b(?:[0-9A-Fa-f]{2}[:-]){5}(?:[0-9A-Fa-f]{2})\b",
            ChecksumKind::None,
            "MAC_ADDR",
        );
    }

    pub fn add_rule(
        &mut self,
        name: &str,
        category: PiiCategory,
        regex_str: &str,
        checksum: ChecksumKind,
        label: &str,
    ) {
        if let Ok(re) = Regex::new(regex_str) {
            self.rules.push(PiiDefinition {
                name: name.to_string(),
                category,
                pattern: re,
                checksum,
                label: label.to_string(),
            });
        }
    }

    /// Redacts all recognized PII in the input text with correlation hashes.
    pub fn sanitize_text(&self, input: &str) -> String {
        let mut output = input.to_string();

        for rule in &self.rules {
            output = rule.pattern.replace_all(&output, |caps: &regex::Captures| {
                let matched = caps.get(0).map(|m| m.as_str()).unwrap_or("");
                let digits: String = matched.chars().filter(|c| c.is_ascii_digit()).collect();

                let is_valid = match rule.checksum {
                    ChecksumKind::None => true,
                    ChecksumKind::Cpf => validate_cpf(&digits),
                    ChecksumKind::Cnpj => validate_cnpj(&digits),
                    ChecksumKind::Ssn => validate_ssn(matched),
                    ChecksumKind::Luhn => validate_luhn(&digits),
                    ChecksumKind::Cns => validate_cns(&digits),
                };

                if is_valid {
                    let hash = correlation_hash(matched);
                    format!("[REDACTED_{}:{}]", rule.label, hash)
                } else {
                    matched.to_string()
                }
            }).to_string();
        }

        output
    }
}
