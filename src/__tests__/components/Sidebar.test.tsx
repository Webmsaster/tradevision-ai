import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Sidebar from '@/components/Sidebar';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [k: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// Mock next/navigation
let mockPathname = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

// Mock ThemeProvider
vi.mock('@/components/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    mockPathname = '/';
  });

  it('renders all navigation links', () => {
    render(<Sidebar />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Trades')).toBeInTheDocument();
    expect(screen.getByText('Analytics')).toBeInTheDocument();
    expect(screen.getByText('AI Insights')).toBeInTheDocument();
    expect(screen.getByText('Calculator')).toBeInTheDocument();
    expect(screen.getByText('Import')).toBeInTheDocument();
    expect(screen.getByText('Report')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders brand name', () => {
    render(<Sidebar />);
    expect(screen.getByText('TradeVision')).toBeInTheDocument();
    expect(screen.getByText('Performance Analyzer')).toBeInTheDocument();
  });

  it('highlights active link for root path', () => {
    mockPathname = '/';
    render(<Sidebar />);
    const dashboardLink = screen.getByText('Dashboard').closest('a');
    expect(dashboardLink?.className).toContain('active');
  });

  it('highlights active link for nested path', () => {
    mockPathname = '/trades';
    render(<Sidebar />);
    const tradesLink = screen.getByText('Trades').closest('a');
    expect(tradesLink?.className).toContain('active');
    const dashboardLink = screen.getByText('Dashboard').closest('a');
    expect(dashboardLink?.className).not.toContain('active');
  });

  it('renders theme toggle button', () => {
    render(<Sidebar />);
    const toggle = screen.getByTitle('Switch to light mode');
    expect(toggle).toBeInTheDocument();
  });

  it('renders mobile toggle button with aria-label', () => {
    render(<Sidebar />);
    const btn = screen.getByLabelText('Toggle navigation');
    expect(btn).toBeInTheDocument();
  });

  it('toggles mobile sidebar on button click', () => {
    render(<Sidebar />);
    const btn = screen.getByLabelText('Toggle navigation');
    fireEvent.click(btn);
    const aside = document.querySelector('aside.sidebar');
    expect(aside?.className).toContain('open');
  });

  it('renders correct href attributes', () => {
    render(<Sidebar />);
    const links = screen.getAllByRole('link');
    const hrefs = links.map(l => l.getAttribute('href'));
    expect(hrefs).toContain('/');
    expect(hrefs).toContain('/trades');
    expect(hrefs).toContain('/analytics');
    expect(hrefs).toContain('/insights');
    expect(hrefs).toContain('/calculator');
    expect(hrefs).toContain('/import');
    expect(hrefs).toContain('/report');
    expect(hrefs).toContain('/settings');
  });

  it('renders footer with copyright', () => {
    render(<Sidebar />);
    expect(screen.getByText(/© 2026 TradeVision/)).toBeInTheDocument();
  });
});
