import { create } from 'zustand';

interface OracleState {
  prices: Record<string, number | null>;
  isFetching: boolean;
  startPolling: (asset: string) => void;
  stopPolling: (asset: string) => void;
}

const activePolls: Record<string, NodeJS.Timeout> = {};

export const useOracleStore = create<OracleState>((set, get) => ({
  prices: {},
  isFetching: false,

  startPolling: (asset) => {
    if (activePolls[asset]) return; // Already polling

    const fetchPrice = async () => {
      try {
        const res = await fetch(`http://localhost:3003/price/${asset}`);
        if (res.ok) {
          const data = await res.json();
          if (data && typeof data.price === 'number') {
            set((state) => ({
              prices: { ...state.prices, [asset]: data.price },
            }));
          }
        } else {
          // Fallback if oracle adapter returns 500/error
          set((state) => ({
            prices: { ...state.prices, [asset]: 2000 },
          }));
        }
      } catch (err) {
        // Mock fallback for unreachable oracle
        set((state) => ({
          prices: { ...state.prices, [asset]: 2000 },
        }));
      }
    };

    // Initial fetch
    void fetchPrice();

    // Poll every 5 seconds
    activePolls[asset] = setInterval(fetchPrice, 5000);
  },

  stopPolling: (asset) => {
    if (activePolls[asset]) {
      clearInterval(activePolls[asset]);
      delete activePolls[asset];
    }
  },
}));
