/// <reference types="vite/client" />

// Ambient module declarations for side-effect CSS imports (design system +
// @fontsource font stylesheets). Vite handles these at build time; this tells
// TypeScript they are valid importable modules with no typed export.
declare module '*.css';
