'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/utils/supabase/server'
import { headers } from 'next/headers'

// Helper to get the current site URL dynamically
async function getSiteUrl() {
    const headersList = await headers()
    const host = headersList.get('x-forwarded-host') || headersList.get('host')
    const protocol = headersList.get('x-forwarded-proto') || (process.env.NODE_ENV === 'production' ? 'https' : 'http')
    const url = `${protocol}://${host}`
    console.log('DEBUG: Detected Site URL:', url)
    return url
}

// Map raw Supabase error messages to generic user-facing strings
function friendlyAuthError(message: string): string {
    if (message.includes('Invalid login credentials') || message.includes('invalid_credentials')) {
        return 'Incorrect email or password.'
    }
    if (message.includes('Email not confirmed')) {
        return 'please verify email to get logged in'
    }
    if (message.includes('User already registered') || message.includes('already registered')) {
        return 'An account with this email already exists.'
    }
    if (message.includes('Password should be')) {
        return 'Password must be at least 6 characters.'
    }
    if (message.includes('rate limit') || message.includes('too many')) {
        return 'Too many attempts. Please wait a moment and try again.'
    }
    return 'Something went wrong. Please try again.'
}

export async function login(formData: FormData) {
    const supabase = await createClient()

    // 1. Verify Turnstile
    const turnstileToken = formData.get('cf-turnstile-response') as string
    const turnstileResult = await verifyTurnstile(turnstileToken)
    if (!turnstileResult.success) {
        redirect(`/login?error=${encodeURIComponent('Security verification failed. Please try again.')}`)
    }

    const data = {
        email: formData.get('email') as string,
        password: formData.get('password') as string,
    }

    const { error } = await supabase.auth.signInWithPassword(data)

    if (error) {
        redirect(`/login?error=${encodeURIComponent(friendlyAuthError(error.message))}`)
    }

    revalidatePath('/', 'layout')
    redirect('/')
}

export async function loginWithGoogle() {
    const supabase = await createClient()
    const siteUrl = await getSiteUrl()

    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: `${siteUrl}/auth/callback`,
        },
    })

    if (error) {
        redirect(`/login?error=${encodeURIComponent(error.message)}`)
    }

    if (data.url) {
        redirect(data.url)
    }
}

export async function signup(formData: FormData) {
    const supabase = await createClient()

    // 1. Verify Turnstile
    const turnstileToken = formData.get('cf-turnstile-response') as string
    const turnstileResult = await verifyTurnstile(turnstileToken)
    if (!turnstileResult.success) {
        redirect(`/signup?error=${encodeURIComponent('Security verification failed. Please try again.')}`)
    }

    const data = {
        email: formData.get('email') as string,
        password: formData.get('password') as string,
    }

    const confirmPassword = formData.get('confirmPassword') as string

    if (data.password !== confirmPassword) {
        redirect(`/signup?error=${encodeURIComponent('Passwords do not match.')}`)
    }

    const siteUrl = await getSiteUrl()
    const { data: authData, error } = await supabase.auth.signUp({
        ...data,
        options: {
            emailRedirectTo: `${siteUrl}/auth/callback`,
        },
    })

    if (error) {
        redirect(`/signup?error=${encodeURIComponent(friendlyAuthError(error.message))}`)
    }

    if (!authData.session) {
        redirect(`/signup?message=${encodeURIComponent('please verify email to get logged in')}`)
    }

    revalidatePath('/', 'layout')
    // Redirect to home upon first sign up
    redirect('/')
}

export async function requestPasswordReset(formData: FormData) {
    const supabase = await createClient()
    const siteUrl = await getSiteUrl()

    // 1. Verify Turnstile
    const turnstileToken = formData.get('cf-turnstile-response') as string
    const turnstileResult = await verifyTurnstile(turnstileToken)
    if (!turnstileResult.success) {
        redirect(`/forgot-password?error=${encodeURIComponent('Security verification failed. Please try again.')}`)
    }

    const email = formData.get('email') as string

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${siteUrl}/auth/callback?next=/reset-password`,
    })

    if (error) {
        redirect(`/forgot-password?error=${encodeURIComponent(error.message)}`)
    }

    redirect(`/forgot-password?message=${encodeURIComponent('Password reset link has been sent to your email.')}`)
}

export async function updatePassword(formData: FormData) {
    const supabase = await createClient()

    const password = formData.get('password') as string
    const confirmPassword = formData.get('confirmPassword') as string

    if (password !== confirmPassword) {
        redirect(`/reset-password?error=${encodeURIComponent('Passwords do not match.')}`)
    }

    const { error } = await supabase.auth.updateUser({
        password: password,
    })

    if (error) {
        redirect(`/reset-password?error=${encodeURIComponent(error.message)}`)
    }

    redirect(`/login?message=${encodeURIComponent('Password has been reset successfully. Please log in.')}`)
}

async function verifyTurnstile(token: string) {
    if (!token) return { success: false }

    const secretKey = process.env.TURNSTILE_SECRET_KEY
    if (!secretKey) {
        if (process.env.NODE_ENV === 'production') {
            console.error('TURNSTILE_SECRET_KEY is not set in production — blocking request.')
            return { success: false }
        }
        console.warn('TURNSTILE_SECRET_KEY is not set. Skipping verification (dev mode).')
        return { success: true }
    }

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`,
    })

    const data = await response.json()
    return { success: data.success }
}
