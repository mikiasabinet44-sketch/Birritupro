// The business's own receiving accounts. Shown on the Home cards and on the customer pay-by-QR page.
export const PROVIDERS: Array<{ code: string; label: string; account: string }> = [
  { code: "CBE", label: "Commercial Bank of Ethiopia", account: process.env.ACCOUNT_CBE ?? "1000599846321" },
  { code: "TELEBIRR", label: "Telebirr", account: process.env.ACCOUNT_TELEBIRR ?? "0926684050" },
  { code: "BOA", label: "Bank of Abyssinia", account: process.env.ACCOUNT_BOA ?? "170182057" },
];
