/**
 * Ethiopian tax calculations (simplified).
 *
 * Rates below reflect commonly published figures (Employment Income Tax
 * Proclamation 979/2016 brackets, Private Organizations' Pension
 * Proclamation 1268/2022 contribution rates, and the standard 15% VAT
 * under Proclamation 1341/2024). Tax law changes periodically — treat these
 * as a configurable starting point (see RATES below) and verify against the
 * current Ministry of Revenue schedule before relying on this for an actual
 * filing.
 */

export const RATES = {
  vatRate: 0.15,
  withholdingRate: 0.02, // standard withholding on qualifying goods/service payments
  pensionEmployeeRate: 0.07,
  pensionEmployerRate: 0.11,
};

// Monthly employment income tax brackets: [lowerBound, rate, deduction]
export const INCOME_TAX_BRACKETS: Array<{ upTo: number; rate: number; deduction: number }> = [
  { upTo: 600, rate: 0, deduction: 0 },
  { upTo: 1650, rate: 0.10, deduction: 60 },
  { upTo: 3200, rate: 0.15, deduction: 142.5 },
  { upTo: 5250, rate: 0.20, deduction: 302.5 },
  { upTo: 7800, rate: 0.25, deduction: 565 },
  { upTo: 10900, rate: 0.30, deduction: 955 },
  { upTo: Infinity, rate: 0.35, deduction: 1500 },
];

/** Monthly employment income tax using the progressive-bracket-with-deduction method. */
export function calcIncomeTax(taxableMonthlyIncome: number): number {
  if (taxableMonthlyIncome <= 0) return 0;
  const bracket = INCOME_TAX_BRACKETS.find((b) => taxableMonthlyIncome <= b.upTo)!;
  const tax = taxableMonthlyIncome * bracket.rate - bracket.deduction;
  return Math.max(0, Math.round(tax * 100) / 100);
}

export interface PayrollCalcInput {
  basicSalary: number;
  taxableAllowance?: number;    // e.g. position/house allowance - taxable
  nonTaxableAllowance?: number; // e.g. transport allowance up to the exempt cap - not taxed
  otherDeductions?: number;
}

export interface PayrollCalcResult {
  grossSalary: number;
  taxableIncome: number;
  incomeTax: number;
  pensionEmployee: number;
  pensionEmployer: number;
  otherDeductions: number;
  netPay: number;
}

export function calcPayroll(input: PayrollCalcInput): PayrollCalcResult {
  const taxableAllowance = input.taxableAllowance ?? 0;
  const nonTaxableAllowance = input.nonTaxableAllowance ?? 0;
  const otherDeductions = input.otherDeductions ?? 0;

  const grossSalary = input.basicSalary + taxableAllowance + nonTaxableAllowance;
  // Pension is calculated on basic salary only, per Ethiopian pension rules.
  const pensionEmployee = Math.round(input.basicSalary * RATES.pensionEmployeeRate * 100) / 100;
  const pensionEmployer = Math.round(input.basicSalary * RATES.pensionEmployerRate * 100) / 100;

  const taxableIncome = input.basicSalary + taxableAllowance - pensionEmployee; // pension is tax-deductible
  const incomeTax = calcIncomeTax(taxableIncome);

  const netPay = grossSalary - incomeTax - pensionEmployee - otherDeductions;

  return {
    grossSalary: round2(grossSalary),
    taxableIncome: round2(taxableIncome),
    incomeTax: round2(incomeTax),
    pensionEmployee: round2(pensionEmployee),
    pensionEmployer: round2(pensionEmployer),
    otherDeductions: round2(otherDeductions),
    netPay: round2(netPay),
  };
}

export function calcVat(exclusiveAmount: number): number {
  return round2(exclusiveAmount * RATES.vatRate);
}

export function calcWithholding(amount: number): number {
  return round2(amount * RATES.withholdingRate);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
