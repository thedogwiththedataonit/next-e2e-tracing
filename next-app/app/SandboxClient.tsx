'use client';

import { useState } from 'react';

export default function SandboxClient() {
  const [isInitializing, setIsInitializing] = useState(false);
  const [isFetchingData, setIsFetchingData] = useState(false);
  const [sandboxUrl, setSandboxUrl] = useState<string | null>(null);
  const [apiData, setApiData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [callCount, setCallCount] = useState(0);

  const handleSpinUpVM = async () => {
    setIsInitializing(true);
    setError(null);
    setApiData(null);
    setCallCount(0);
    
    try {
      // Call /api/sandbox-init to spin up the sandbox
      const sandboxResponse = await fetch('/api/sandbox-init', {
        method: 'POST',
      });
      
      if (!sandboxResponse.ok) {
        throw new Error('Failed to initialize sandbox');
      }
      
      const { url } = await sandboxResponse.json();
      setSandboxUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsInitializing(false);
    }
  };

  const handleCallAPI = async () => {
    if (!sandboxUrl) return;
    
    setIsFetchingData(true);
    setError(null);
    
    try {
      // Call /api/call with the sandbox URL
      const dataResponse = await fetch('/api/call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sandboxUrl }),
      });
      
      if (!dataResponse.ok) {
        throw new Error('Failed to fetch data from sandbox');
      }
      
      const data = await dataResponse.json();
      setApiData(data);
      setCallCount(prev => prev + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsFetchingData(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 items-center justify-center w-full max-w-2xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-4">Vercel Sandbox Demo</h1>
      
      <button
        onClick={handleSpinUpVM}
        disabled={isInitializing || !!sandboxUrl}
        className="rounded-full border border-solid border-transparent transition-colors flex items-center justify-center bg-foreground text-background gap-2 hover:bg-[#383838] dark:hover:bg-[#ccc] font-medium text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isInitializing ? 'Initializing Sandbox...' : sandboxUrl ? 'Sandbox Running' : 'Initialize Sandbox'}
      </button>
      
      {sandboxUrl && (
        <>
          <div className="mt-4 p-4 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-100 rounded w-full">
            <p className="text-sm mb-2">✅ Sandbox is running!</p>
            <p className="text-xs">Flask API URL: <code className="font-mono">{sandboxUrl}</code></p>
          </div>
          
          <button
            onClick={handleCallAPI}
            disabled={isFetchingData}
            className="rounded-full border border-solid border-black dark:border-white transition-colors flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 font-medium text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isFetchingData ? 'Calling API...' : 'Call Flask API'}
          </button>
          
          {callCount > 0 && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              API called {callCount} time{callCount !== 1 ? 's' : ''}
            </p>
          )}
        </>
      )}
      
      {error && (
        <div className="mt-4 p-4 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-100 rounded w-full">
          Error: {error}
        </div>
      )}
      
      {apiData && (
        <div className="mt-4 p-4 bg-gray-100 dark:bg-gray-800 rounded w-full">
          <h2 className="text-lg font-semibold mb-2">API Response:</h2>
          <pre className="overflow-auto text-sm">
            {JSON.stringify(apiData, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
