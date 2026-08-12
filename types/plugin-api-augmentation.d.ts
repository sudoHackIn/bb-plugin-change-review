import type { JsonValue } from "@bb/plugin-sdk/app";

declare module "@bb/plugin-sdk/app" {
  interface BbNavigate {
    openThreadPanel(options: {
      actionId: string;
      title?: string;
      params?: JsonValue;
      experimental_filePath?: string;
    }): boolean;
  }
}
