import { Given } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

// The mock's own logins with one for Oh My Pi added, in no pool.
Given('the runner has an Oh My Pi login outside every pool', async function (this: ThreadbearWorld) {
  const out = await this.app.do({ cmd: 'mock', method: 'accounts', params: {} });
  const text = typeof out === 'string' ? out.slice(out.indexOf('{')) : JSON.stringify(out);
  const { accounts } = JSON.parse(text) as { accounts: { id: string }[] };
  const omp = {
    id: 'omp-main', provider: 'omp', title: 'Oh My Pi', configDir: '', defaultModel: 'pi-small',
    models: [{ id: 'pi-small', model: 'pi-small', title: 'Pi Small' }, { id: 'pi-large', model: 'pi-large', title: 'Pi Large' }],
  };
  await this.app.do({ cmd: 'mock', method: 'accounts', params: { accounts: [...accounts.filter((a) => a.id !== omp.id), omp] } });
});
