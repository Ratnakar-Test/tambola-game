module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "google",
  ],
  parserOptions: {
    ecmaVersion: 2020, // or a more recent version like 2022 if using newer syntax
    // sourceType: "module", // Uncomment if you are using ES modules (import/export)
  },
  rules: {
    "quotes": ["error", "double"],
    "indent": ["error", 2, { "SwitchCase": 1 }],
    "object-curly-spacing": ["error", "always"],
    "max-len": ["error", { "code": 120, "ignoreComments": true, "ignoreUrls": true }],
    "require-jsdoc": "off", // Turn off JSDoc requirement
    "valid-jsdoc": "off", // Turn off JSDoc validation
    "operator-linebreak": ["error", "after"],
    "linebreak-style": ["error", "unix"], // Enforce LF line endings
    "no-restricted-globals": ["error", "name", "length"],
    "prefer-promise-reject-errors": ["error"],
    "comma-dangle": ["error", "always-multiline"], // Optional: for cleaner git diffs
    "arrow-parens": ["error", "always"], // Consistent parentheses for arrow functions
    // Add or override other rules as needed
    // e.g. if you use 'let' that could be 'const' but want to allow it:
    // "prefer-const": "warn",
  },
};
