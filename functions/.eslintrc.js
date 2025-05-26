{
  "env": {
    "es6": true,
    "node": true
  },
  "parserOptions": {
    "ecmaVersion": 2020
  },
  "extends": [
    "eslint:recommended",
    "google"
  ],
  "rules": {
    "quotes": ["error", "double"],
    "indent": ["error", 2],
    "linebreak-style": ["off"], // Or ["warn", "unix"] to warn instead of error, or ["error", "unix"] if you fix them
    "object-curly-spacing": ["error", "always"],
    "max-len": ["warn", { "code": 120, "ignoreUrls": true, "ignoreStrings": true, "ignoreTemplateLiterals": true }],
    "require-jsdoc": "off", // If you don't want to enforce JSDoc comments
    "valid-jsdoc": "off",   // If you don't want to enforce JSDoc comments
    "new-cap": ["error", { "newIsCap": true, "capIsNew": false, "properties": true }],
    "comma-dangle": ["error", "always-multiline"]
  }
}
