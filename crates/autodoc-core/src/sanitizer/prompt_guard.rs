/// Semantic framing defensive shield against indirect prompt injection (OWASP LLM01).
/// Wraps untrusted third-party code, docstrings, and comments in structured delimiter tags
/// and escapes model control tokens.

pub fn wrap_untrusted_code(content: &str, origin: &str, file: &str, symbol: &str) -> String {
    // 1. Escape any premature closing tags that an adversary might inject
    let escaped = content
        .replace("</untrusted_code_context>", "&lt;/untrusted_code_context&gt;")
        .replace("<untrusted_code_context", "&lt;untrusted_code_context")
        // 2. Neutralize model special control tokens
        .replace("<|im_start|>", "[NEUTRALIZED_TOKEN_IM_START]")
        .replace("<|im_end|>", "[NEUTRALIZED_TOKEN_IM_END]")
        .replace("[INST]", "[NEUTRALIZED_TOKEN_INST]")
        .replace("[/INST]", "[NEUTRALIZED_TOKEN_SLASH_INST]")
        .replace("<<SYS>>", "[NEUTRALIZED_TOKEN_SYS]")
        .replace("<</SYS>>", "[NEUTRALIZED_TOKEN_SLASH_SYS]");

    format!(
        "<untrusted_code_context origin=\"{origin}\" file=\"{file}\" symbol=\"{symbol}\">\n{escaped}\n</untrusted_code_context>"
    )
}
