import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Orchestra",
  description:
    "A configurable, Git-backed, code-planning refinement utility.",
  lang: "en-US",
  lastUpdated: true,
  cleanUrls: true,
  base: "/orchestra/",

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Reference", link: "/reference/roles" },
      { text: "API", link: "/reference/api" },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Introduction",
          items: [
            { text: "What is Orchestra?", link: "/guide/" },
            { text: "Quick Start", link: "/guide/quick-start" },
            { text: "How It Works", link: "/guide/how-it-works" },
          ],
        },
        {
          text: "Building Networks",
          items: [
            { text: "Agent Networks", link: "/guide/networks" },
            { text: "Steering & Interventions", link: "/guide/steering" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Roles Catalog", link: "/reference/roles" },
            { text: "Configuration", link: "/reference/config" },
            { text: "API Reference", link: "/reference/api" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/ubcs-io/orchestra" },
    ],

    search: {
      provider: "local",
    },

    editLink: {
      pattern: "https://github.com/ubcs-io/orchestra/edit/main/docs/:path",
    },
  },
});