use std::collections::HashMap;

/// Calculates Shannon entropy of a given ASCII/UTF-8 string:
/// H = - sum( p(x) * log2(p(x)) )
pub fn shannon_entropy(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }

    let mut freq: HashMap<u8, f64> = HashMap::new();
    let mut total: f64 = 0.0;

    for b in s.bytes() {
        *freq.entry(b).or_insert(0.0) += 1.0;
        total += 1.0;
    }

    let mut entropy: f64 = 0.0;
    for count in freq.values() {
        let p: f64 = *count / total;
        entropy -= p * p.log2();
    }

    entropy
}

/// Computes a fast 4-character hex hash for deterministic correlation without data leakage.
pub fn correlation_hash(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let result = hasher.finalize();
    format!("{:02x}{:02x}", result[0], result[1])
}
