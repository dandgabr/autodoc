/// Calculates cyclomatic complexity for a given block of code.
/// Starts at base complexity of 1, incrementing for each branching keyword or operator.
pub fn calculate_text_complexity(code: &str) -> i32 {
    let mut complexity = 1;
    for line in code.lines() {
        let trimmed = line.trim();
        // Skip pure comments
        if trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with("/*") || trimmed.starts_with('*') {
            continue;
        }

        // Branching keywords
        let branch_keywords = [
            "if ", "if(", "elif ", "elif(", "else if", "while ", "while(",
            "for ", "for(", "case ", "catch ", "catch(", "except ", "except:",
            "&&", "||", " ? ",
        ];

        for kw in branch_keywords {
            complexity += trimmed.matches(kw).count() as i32;
        }
    }
    complexity.clamp(1, 100)
}
