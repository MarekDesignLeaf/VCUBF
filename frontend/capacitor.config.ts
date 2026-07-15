import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "cz.vcubf.secretary",
  appName: "VCUBF Secretary",
  webDir: "dist",
  bundledWebRuntime: false,
  server: {
    url: "https://frontend-production-ee13.up.railway.app",
    androidScheme: "https",
    cleartext: false,
  },
};

export default config;
