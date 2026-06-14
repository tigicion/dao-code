import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// 务实配置:抓真问题(未用变量/不可达/重复 case…),但不强加风格、不为既有代码大改而设噪音规则。
export default tseslint.config(
  { ignores: ["dist/**", "dao", "evals/**", "scripts/**", "**/*.config.js", "**/*.config.ts", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn", // 警告即可,不为既有 effect 大改而阻断 CI
      "@typescript-eslint/no-explicit-any": "off", // API 载荷/MCP 结果处用 any 是有意的
      "@typescript-eslint/no-non-null-assertion": "off", // 代码大量用 ! 断言(已读校验后)
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/ban-ts-comment": "warn",
      "no-empty": ["error", { allowEmptyCatch: true }], // catch {} 是有意的容错
      "no-constant-condition": ["error", { checkLoops: false }], // for(;;)/while(true) 循环允许
      "no-control-regex": "off", // sanitize.ts 故意匹配控制字符
      "require-yield": "off", // 仅 return 的 async generator(测试桩/兜底路径)是有意的
    },
  },
);
