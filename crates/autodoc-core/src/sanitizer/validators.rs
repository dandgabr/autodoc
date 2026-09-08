/// Checksum validation implementations for regional & domain-specific identifiers.

/// Validates Brazilian CPF via Modulo 11
pub fn validate_cpf(digits_only: &str) -> bool {
    if digits_only.len() != 11 {
        return false;
    }
    // Check for repetitive digits (e.g. 111.111.111-11)
    let first = digits_only.as_bytes()[0];
    if digits_only.bytes().all(|b| b == first) {
        return false;
    }

    let digits: Vec<u32> = digits_only.chars().filter_map(|c| c.to_digit(10)).collect();
    if digits.len() != 11 {
        return false;
    }

    // 1st verifier digit
    let sum1: u32 = digits[0..9].iter().enumerate().map(|(i, &d)| d * (10 - i as u32)).sum();
    let rem1 = sum1 % 11;
    let d1 = if rem1 < 2 { 0 } else { 11 - rem1 };
    if digits[9] != d1 {
        return false;
    }

    // 2nd verifier digit
    let sum2: u32 = digits[0..10].iter().enumerate().map(|(i, &d)| d * (11 - i as u32)).sum();
    let rem2 = sum2 % 11;
    let d2 = if rem2 < 2 { 0 } else { 11 - rem2 };
    digits[10] == d2
}

/// Validates Brazilian CNPJ via Modulo 11
pub fn validate_cnpj(digits_only: &str) -> bool {
    if digits_only.len() != 14 {
        return false;
    }
    let first = digits_only.as_bytes()[0];
    if digits_only.bytes().all(|b| b == first) {
        return false;
    }

    let digits: Vec<u32> = digits_only.chars().filter_map(|c| c.to_digit(10)).collect();
    if digits.len() != 14 {
        return false;
    }

    let weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum1: u32 = digits[0..12].iter().zip(weights1.iter()).map(|(&d, &w)| d * w).sum();
    let rem1 = sum1 % 11;
    let d1 = if rem1 < 2 { 0 } else { 11 - rem1 };
    if digits[12] != d1 {
        return false;
    }

    let weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum2: u32 = digits[0..13].iter().zip(weights2.iter()).map(|(&d, &w)| d * w).sum();
    let rem2 = sum2 % 11;
    let d2 = if rem2 < 2 { 0 } else { 11 - rem2 };
    digits[13] == d2
}

/// Validates US Social Security Number (SSN) syntax and prohibited ranges
pub fn validate_ssn(raw: &str) -> bool {
    let clean: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if clean.len() != 9 {
        return false;
    }
    let area: u32 = clean[0..3].parse().unwrap_or(0);
    let group: u32 = clean[3..5].parse().unwrap_or(0);
    let serial: u32 = clean[5..9].parse().unwrap_or(0);

    // Invalid ranges under SSA rules: 000, 666, 900-999
    if area == 0 || area == 666 || area >= 900 {
        return false;
    }
    if group == 0 || serial == 0 {
        return false;
    }
    true
}

/// Validates Credit Card PAN via Luhn Algorithm (Modulo 10)
pub fn validate_luhn(digits_only: &str) -> bool {
    if digits_only.len() < 13 || digits_only.len() > 19 {
        return false;
    }
    let mut sum = 0;
    let mut alternate = false;
    for c in digits_only.chars().rev() {
        if let Some(mut d) = c.to_digit(10) {
            if alternate {
                d *= 2;
                if d > 9 {
                    d -= 9;
                }
            }
            sum += d;
            alternate = !alternate;
        } else {
            return false;
        }
    }
    sum % 10 == 0
}

/// Validates Brazilian National Health Card (CNS) via Modulo 11
pub fn validate_cns(digits_only: &str) -> bool {
    if digits_only.len() != 15 {
        return false;
    }
    let first = digits_only.chars().next().unwrap_or(' ');
    if first == '1' || first == '2' {
        // Format 1/2
        let digits: Vec<u32> = digits_only.chars().filter_map(|c| c.to_digit(10)).collect();
        if digits.len() != 15 {
            return false;
        }
        let sum: u32 = digits[0..11].iter().enumerate().map(|(i, &d)| d * (15 - i as u32)).sum();
        let rem = sum % 11;
        let mut dv = if rem == 0 { 0 } else { 11 - rem };
        if dv == 10 {
            let sum2 = sum + 2;
            let rem2 = sum2 % 11;
            dv = if rem2 == 0 { 0 } else { 11 - rem2 };
        }
        digits[14] == dv || digits_only.ends_with(&format!("{:04}", dv))
    } else if first == '7' || first == '8' || first == '9' {
        let digits: Vec<u32> = digits_only.chars().filter_map(|c| c.to_digit(10)).collect();
        if digits.len() != 15 {
            return false;
        }
        let sum: u32 = digits.iter().enumerate().map(|(i, &d)| d * (15 - i as u32)).sum();
        sum % 11 == 0
    } else {
        false
    }
}
