import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
export async function getPropertyByName(name) {
    const { data, error } = await supabase
        .from('properties')
        .select('*')
        .ilike('name', `%${name}%`)
        .limit(1)
        .single();
    if (error)
        return null;
    return data;
}
export async function searchProperties(filters) {
    let query = supabase.from('properties').select('*');
    if (filters.name) {
        query = query.ilike('name', `%${filters.name}%`);
    }
    if (filters.address) {
        query = query.ilike('address', `%${filters.address}%`);
    }
    if (filters.square_footage_min) {
        query = query.gte('square_footage', filters.square_footage_min);
    }
    if (filters.square_footage_max) {
        query = query.lte('square_footage', filters.square_footage_max);
    }
    if (filters.price_min) {
        query = query.gte('price', filters.price_min);
    }
    if (filters.price_max) {
        query = query.lte('price', filters.price_max);
    }
    const { data, error } = await query;
    if (error)
        return [];
    return data;
}
export async function getPriceSummary() {
    const { data, error } = await supabase
        .from('properties')
        .select('price, name');
    if (error)
        return null;
    const total = data.reduce((sum, p) => sum + p.price, 0);
    const avg = total / data.length;
    return {
        total_listings: data.length,
        average_price: avg,
        most_expensive: data.reduce((max, p) => p.price > max.price ? p : max),
        least_expensive: data.reduce((min, p) => p.price < min.price ? p : min),
    };
}
export async function getMarketAnalytics(city) {
    let query = supabase.from('properties').select('price, square_footage, address');
    if (city) {
        query = query.ilike('address', `%${city}%`);
    }
    const { data, error } = await query;
    if (error || !data || data.length === 0)
        return null;
    const prices = data.map((p) => p.price);
    const ppsf = data
        .filter((p) => p.square_footage > 0)
        .map((p) => p.price / p.square_footage);
    const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    return {
        scope: city ?? 'all markets',
        listings: data.length,
        average_price: Math.round(avg(prices)),
        min_price: Math.min(...prices),
        max_price: Math.max(...prices),
        avg_price_per_sqft: ppsf.length ? Math.round(avg(ppsf)) : null,
    };
}
export async function findUserByEmail(email) {
    const { data } = await supabase
        .from('users') // whatever the user table is in the vendor's database
        .select('id')
        .eq('email', email)
        .single();
    return data;
}
