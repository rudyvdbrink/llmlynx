export function generateRecoveryCode(): string {
    // 12 numeric digits, preserving leading zeros
    let code = "";
    for (let i = 0; i < 12; i++) {
      code += Math.floor(Math.random() * 10).toString();
    }
    return code;
  }