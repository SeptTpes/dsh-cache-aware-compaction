# MiniProject

## Overview

This repository contains a small Node.js service called "token-adder" that reads a JSON config file, sums a list of numbers, and writes the result to an output file. The main entry is src/main.js.

## Files

- src/main.js — entry point: loads config.json, computes the sum, writes result.txt
- src/sum.js — exports `sumArray(numbers)` returning the sum
- config.json — sample config with `numbers` array
- package.json — name token-adder, version 1.0.0, type module

## Config format

```json
{
  "numbers": [1, 2, 3]
}
```

## Known issue

The current sum.js implementation uses a naive loop. A reported bug says it returns 0 for negative numbers when the config file is missing the `numbers` key.
