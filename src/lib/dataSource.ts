import type { DataSource } from '../types';
import { directSource } from './directSource';
import { isSupabaseConfigured } from './supabaseClient';
import { supabaseSource } from './supabaseSource';

/**
 * Supabase wins when it's configured, because in a deployed build the Vite dev
 * proxy no longer exists and direct calls to NSE/Yahoo would be blocked by CORS.
 */
export const activeSource: DataSource = isSupabaseConfigured ? supabaseSource : directSource;
