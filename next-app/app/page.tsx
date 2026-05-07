import FlaskApiClient from './FlaskApiClient';

export default function Home() {
  return (
    <div className="font-sans grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20">
      <main className="flex flex-col gap-[32px] row-start-2 items-center sm:items-start">
        <FlaskApiClient />
      </main>
      <footer className="row-start-3 flex gap-[24px] flex-wrap items-center justify-center text-sm text-gray-600 dark:text-gray-400">
        <p>Next.js + Flask end-to-end Datadog tracing demo</p>
      </footer>
    </div>
  );
}
