import type { Config } from "tailwindcss";

// Sandiva brand tokens — locked by the approved mockup (see plan: UI/UX).
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: "#003D5A",
          700: "#013049",
          300: "#4E7E97",
        },
        gold: {
          DEFAULT: "#B9B400",
          ink: "#5f5c00",
          soft: "#f2f0c2",
        },
        plum: "#522B4C",
        burgundy: "#792C38",
        good: "#2E7D5B",
      },
      borderRadius: {
        card: "12px",
      },
    },
  },
  plugins: [],
};
export default config;
