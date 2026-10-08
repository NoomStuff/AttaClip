import { z } from "zod";
import { validFilenameTemplate } from "./filename";
export const preferencesSchema = z
   .object({
      collection: z.string().trim().min(1).max(4096),
      clipSeconds: z.number().int().min(5).max(1800),
      shortcut: z.string().min(1).max(100),
      quality: z.enum(["low", "standard", "high", "custom"]),
      customWidth: z
         .number()
         .int()
         .min(64)
         .max(7680)
         .refine((value) => value % 2 === 0, "Use an even recording width"),
      customHeight: z
         .number()
         .int()
         .min(64)
         .max(4320)
         .refine((value) => value % 2 === 0, "Use an even recording height"),
      customFPS: z.number().int().min(1).max(120),
      customCQ: z.number().int().min(12).max(35),
      allowSoftwareEncoder: z.boolean(),
      sourceKind: z.enum(["screen", "app", "auto"]),
      sourceId: z.string().max(1000),
      microphone: z.boolean(),
      microphoneDevice: z.string().max(1000),
      captureAudio: z.boolean(),
      captureVolume: z.number().min(0).max(2),
      captureMuted: z.boolean(),
      microphoneVolume: z.number().min(0).max(2),
      microphoneMuted: z.boolean(),
      desktopFallback: z.boolean(),
      customGames: z
         .array(z.object({ name: z.string().trim().min(1).max(200), executable: z.string().min(1).max(4096) }).strict())
         .max(500)
         .default([]),
      shareSizeMB: z.number().min(1).max(2000),
      autoShare: z.boolean(),
      startWithOS: z.boolean(),
      autoRecord: z.boolean(),
      notifications: z.enum(["everywhere", "outside-fullscreen", "off"]),
      sound: z.boolean(),
      avoidOverlap: z.boolean(),
      folderLayout: z.enum(["flat", "application"]),
      filenamePreset: z.enum(["source-date", "date-source", "custom"]),
      filenameTemplate: z.string().refine(validFilenameTemplate, "Use supported filename tokens without folder separators"),
      setupComplete: z.boolean(),
   })
   .strict();
export const idSchema = z.string().min(1).max(200);
export const categoryRequest = z
   .object({
      id: z.string().max(200).optional(),
      name: z.string().trim().min(1).max(80).optional(),
      color: z
         .string()
         .regex(/^#[0-9a-fA-F]{6}$/)
         .optional(),
      clipId: z.string().max(200).optional(),
      categoryIds: z.array(z.string().max(200)).max(100).optional(),
   })
   .strict();
