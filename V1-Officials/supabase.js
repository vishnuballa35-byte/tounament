const SUPABASE_URL = "https://jgfrwxqfphjrjqhaguso.supabase.co";

const SUPABASE_KEY = "sb_publishable_TjCGmzmnDw0nnOogOEAy_A__5sboyMP";

const supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_KEY
);

window.supabaseClient = supabaseClient;