import { protectedComputeContractError } from "./protectedComputeError.js";
import { normalizePrivateProfitInput, validatePrivateProfitResult } from './privateProfitContract.js';

const PROFITABILITY_QUOTE_FIELDS = Object.freeze([
  "acquiringBasisPoints",
  "commissionBasisPoints",
  "costMinor",
  "currency",
  "logisticsMinor",
  "salePriceMinor",
  "taxBasisPoints",
]);
const COLLECTION_PRICING_QUOTE_FIELDS = Object.freeze([
  "commissionBasisPoints",
  "currency",
  "currentPriceMinor",
  "extraCostMinor",
  "firstMileCostMinor",
  "purchaseCostMinor",
  "targetMarginBasisPoints",
]);

function normalizeInteger(value, field, { min = 0, max = 300_000_000_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_INPUT_INVALID",
      `${field} must be a safe integer between ${min} and ${max}.`,
      { field },
    );
  }
  return value;
}

function validateProfitabilityQuoteResult(result) {
  const expectedFields = [
    "contributionMinor",
    "currency",
    "decision",
    "marginBasisPoints",
  ];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_RESULT_CONTRACT_INVALID",
      "Protected profitability result must be an object.",
    );
  }
  const keys = Object.keys(result).sort();
  if (
    keys.length !== expectedFields.length ||
    keys.some((key, index) => key !== expectedFields[index]) ||
    !Number.isSafeInteger(result.contributionMinor) ||
    !Number.isSafeInteger(result.marginBasisPoints) ||
    !/^[A-Z]{3}$/u.test(result.currency || "") ||
    !["reject", "review", "acceptable", "preferred"].includes(
      result.decision,
    )
  ) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_RESULT_CONTRACT_INVALID",
      "Protected profitability result does not match its typed contract.",
    );
  }
  return result;
}

function normalizeOptionalPositiveInteger(value, field) {
  if (value === null) return null;
  return normalizeInteger(value, field, { min: 1 });
}

function validateCollectionPricingQuoteResult(result) {
  const expectedFields = [
    "breakEvenPriceMinor",
    "currency",
    "currentMarginBasisPoints",
    "currentProfitMinor",
    "suggestedPriceMinor",
    "totalCostMinor",
  ];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_RESULT_CONTRACT_INVALID",
      "Protected collection pricing result must be an object.",
    );
  }
  const keys = Object.keys(result).sort();
  const nullableIntegers = [
    result.currentMarginBasisPoints,
    result.currentProfitMinor,
  ];
  if (
    keys.length !== expectedFields.length ||
    keys.some((key, index) => key !== expectedFields[index]) ||
    !Number.isSafeInteger(result.breakEvenPriceMinor) ||
    result.breakEvenPriceMinor < 0 ||
    !Number.isSafeInteger(result.suggestedPriceMinor) ||
    result.suggestedPriceMinor < 0 ||
    !Number.isSafeInteger(result.totalCostMinor) ||
    result.totalCostMinor < 0 ||
    nullableIntegers.some(
      (value) => value !== null && !Number.isSafeInteger(value),
    ) ||
    !/^[A-Z]{3}$/u.test(result.currency || "")
  ) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_RESULT_CONTRACT_INVALID",
      "Protected collection pricing result does not match its typed contract.",
    );
  }
  return result;
}

function normalizeProfitabilityQuote(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_INPUT_INVALID",
      "Protected profitability input must be an object.",
    );
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== PROFITABILITY_QUOTE_FIELDS.length ||
    keys.some((key, index) => key !== PROFITABILITY_QUOTE_FIELDS[index])
  ) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_INPUT_FIELDS_INVALID",
      "Protected profitability input fields do not match the capability contract.",
      { expectedFields: PROFITABILITY_QUOTE_FIELDS, actualFields: keys },
    );
  }
  const currency = String(input.currency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_INPUT_INVALID",
      "currency must be a three-letter ISO code.",
      { field: "currency" },
    );
  }
  return {
    acquiringBasisPoints: normalizeInteger(
      input.acquiringBasisPoints,
      "acquiringBasisPoints",
      { max: 10_000 },
    ),
    commissionBasisPoints: normalizeInteger(
      input.commissionBasisPoints,
      "commissionBasisPoints",
      { max: 10_000 },
    ),
    costMinor: normalizeInteger(input.costMinor, "costMinor"),
    currency,
    logisticsMinor: normalizeInteger(input.logisticsMinor, "logisticsMinor"),
    salePriceMinor: normalizeInteger(input.salePriceMinor, "salePriceMinor", {
      min: 1,
    }),
    taxBasisPoints: normalizeInteger(input.taxBasisPoints, "taxBasisPoints", {
      max: 10_000,
    }),
  };
}

function normalizeCollectionPricingQuote(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_INPUT_INVALID",
      "Protected collection pricing input must be an object.",
    );
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== COLLECTION_PRICING_QUOTE_FIELDS.length ||
    keys.some(
      (key, index) => key !== COLLECTION_PRICING_QUOTE_FIELDS[index],
    )
  ) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_INPUT_FIELDS_INVALID",
      "Protected collection pricing fields do not match the capability contract.",
      { expectedFields: COLLECTION_PRICING_QUOTE_FIELDS, actualFields: keys },
    );
  }
  const currency = String(input.currency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_INPUT_INVALID",
      "currency must be a three-letter ISO code.",
      { field: "currency" },
    );
  }
  return {
    commissionBasisPoints: normalizeInteger(
      input.commissionBasisPoints,
      "commissionBasisPoints",
      { max: 10_000 },
    ),
    currency,
    currentPriceMinor: normalizeOptionalPositiveInteger(
      input.currentPriceMinor,
      "currentPriceMinor",
    ),
    extraCostMinor: normalizeInteger(input.extraCostMinor, "extraCostMinor"),
    firstMileCostMinor: normalizeInteger(
      input.firstMileCostMinor,
      "firstMileCostMinor",
    ),
    purchaseCostMinor: normalizeInteger(
      input.purchaseCostMinor,
      "purchaseCostMinor",
    ),
    targetMarginBasisPoints: normalizeInteger(
      input.targetMarginBasisPoints,
      "targetMarginBasisPoints",
      { max: 1_000_000 },
    ),
  };
}

const CAPABILITIES = new Map([
  [
    "profitability.quote@1",
    Object.freeze({
      capability: "profitability.quote",
      validateResult: validateProfitabilityQuoteResult,
      version: 1,
      normalizeInput: normalizeProfitabilityQuote,
    }),
  ],
  [
    "collection-pricing.quote@1",
    Object.freeze({
      capability: "collection-pricing.quote",
      validateResult: validateCollectionPricingQuoteResult,
      version: 1,
      normalizeInput: normalizeCollectionPricingQuote,
    }),
  ],
  [
    'profit.ledger-batch@1',
    Object.freeze({ capability: 'profit.ledger-batch', version: 1,
      normalizeInput: normalizePrivateProfitInput, validateResult: validatePrivateProfitResult }),
  ],
]);

export function getProtectedComputeCapability(capability, version) {
  const normalizedCapability = String(capability || "").trim();
  const normalizedVersion = Number(version);
  const descriptor = CAPABILITIES.get(
    `${normalizedCapability}@${normalizedVersion}`,
  );
  if (!descriptor) {
    throw protectedComputeContractError(
      "PROTECTED_COMPUTE_CAPABILITY_UNSUPPORTED",
      "The requested protected-compute capability/version is unsupported.",
      { capability: normalizedCapability, version: normalizedVersion },
    );
  }
  return descriptor;
}

export function listProtectedComputeContracts() {
  return [...CAPABILITIES.values()].map(({ capability, version }) => ({
    capability,
    version,
  }));
}
