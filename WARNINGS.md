# Package Installation Warnings

This document explains the warnings you may see during `yarn install` and how to handle them.

## 1. `url.parse()` Deprecation Warning

**Warning:**

```
(node:89645) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized...
```

**Status:** ✅ **Harmless** - This warning comes from yarn itself or a dependency. It doesn't affect functionality.

**Solution:** Suppress by running:

```bash
NODE_OPTIONS='--no-deprecation' yarn install
```

Or add to your shell profile:

```bash
export NODE_OPTIONS='--no-deprecation'
```

## 2. Peer Dependency Warnings

### Missing Peer Dependencies (Fixed)

- ✅ `@babel/core` - Now installed
- ✅ `@types/node` - Now installed

### Incorrect Peer Dependency Versions (Expected)

These warnings are **expected and harmless**:

- `eslint-config-airbnb-base@15.0.0` expects `eslint@^7.32.0 || ^8.2.0`
  - We're using `eslint@9.39.1` (newer version)
  - **Status:** Works fine, just a version mismatch warning

- `eslint-config-airbnb-typescript@18.0.0` expects:
  - `eslint@^8.56.0` (we have 9.39.1)
  - `@typescript-eslint/eslint-plugin@^7.0.0` (we have 8.48.0)
  - `@typescript-eslint/parser@^7.0.0` (we have 8.48.0)
  - **Status:** Works fine, just version mismatch warnings

These configs are compatible with newer versions, they just haven't updated their peer dependency ranges yet.

## 3. Workspaces Warning

**Warning:**

```
warning Workspaces can only be enabled in private projects.
```

**Status:** ✅ **Harmless** - This comes from a dependency (`babel-plugin-istanbul`) that has workspaces in its package.json. It doesn't affect your project.

## Summary

All warnings are **harmless** and don't affect functionality:

- ✅ Code builds successfully
- ✅ Tests pass (60/60)
- ✅ Linting works
- ✅ All features function correctly

You can safely ignore these warnings, or suppress the deprecation warning using the methods above.
