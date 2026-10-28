"""Build isolated test SQL from the verified Directory model/migrations.

Read source only. Never opens the source deployment database or copies env files.
Run using the existing Portal virtualenv, with an explicit source and output dir.
"""
import argparse
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--portal-source', required=True)
parser.add_argument('--out-dir', required=True)
args = parser.parse_args()
source = Path(args.portal_source).resolve() / 'directory'
local = Path(__file__).resolve().parent
if (source / 'migrations' / '0005_tenant_administrator.py').exists():
    raise SystemExit('Migration name already exists; review and rebase before preparing patches.')
out = Path(args.out_dir).resolve()
expected = '3db0468a9ab74c7d3f4cea0496bf3e457eb51caab30a3b0da178b443971b0eb6'
if hashlib.sha256((source / 'models.py').read_bytes()).hexdigest() != expected:
    raise SystemExit('Directory source changed; review the new model first.')
with tempfile.TemporaryDirectory(prefix='hs-directory-fixture-') as folder:
    root = Path(folder)
    directory = root / 'directory'
    (directory / 'migrations').mkdir(parents=True)
    (directory / '__init__.py').write_text('')
    (directory / 'models.py').write_bytes((source / 'models.py').read_bytes() + (local / 'tenant-administrator-model.py').read_bytes())
    for path in (source / 'migrations').glob('*.py'):
        shutil.copyfile(path, directory / 'migrations' / path.name)
    shutil.copyfile(local / '0005_tenant_administrator.py', directory / 'migrations' / '0005_tenant_administrator.py')
    sys.path.insert(0, str(root))
    from django.conf import settings
    settings.configure(INSTALLED_APPS=['directory'], SECRET_KEY='synthetic-test-only', DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': str(root / 'fixture.sqlite3')}}, DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', USE_TZ=True)
    import django
    django.setup()
    from django.core.management import call_command
    call_command('makemigrations', 'directory', check=True, dry_run=True, verbosity=0)
    call_command('migrate', verbosity=0)
    from directory.models import Person, Organisation, ExternalSubject, OrganisationMember, ApplicationAccess, ResourceMapping, Snapshot, ConnectorState, TenantAdministrator, AdminScope
    from django.utils import timezone
    person = Person.objects.create(id='00000000-0000-4000-8000-000000000001', email='qa@example.invalid', status='active', suite_role='super_admin')
    tenant = Organisation.objects.create(id='00000000-0000-4000-8000-000000000002', name='Synthetic test tenant')
    ExternalSubject.objects.create(person=person, issuer='https://accounts.example.test', subject='fixture-subject')
    OrganisationMember.objects.create(person=person, organisation=tenant, status='active')
    ApplicationAccess.objects.create(person=person, organisation=tenant, application='holy-sheet', status='active')
    ResourceMapping.objects.create(organisation=tenant, application='holy-sheet', resource_type='workspace', resource_id='fixture-workspace', review_reference='Synthetic fixture only')
    snapshot = Snapshot.objects.create(database='synthetic', ciphertext_sha256='a' * 64, captured_at='fixture', table_statistics={}, restore_verified=True)
    ConnectorState.objects.create(application='holy-sheet', mode='central', baseline=snapshot, permission_contract_sha256='b' * 64, parity_verified_at=timezone.now(), revocation_verified_at=timezone.now())
    TenantAdministrator.objects.create(person=person, organisation=tenant, application='holy-sheet', active=False, review_reference='Synthetic inactive grant')
    AdminScope.objects.create(person=person, organisation=tenant, application='holy-sheet', resource_type='tenant', resource_id=str(tenant.pk), allowed_roles=['admin'], active=True)
    from django.db import connection
    connection.close()
    import sqlite3
    db = sqlite3.connect(root / 'fixture.sqlite3')
    sql = '\n'.join(db.iterdump()) + '\n'
    db.close()
    out.mkdir(parents=True, exist_ok=True)
    (out / 'directory-fixture.sql').write_text(sql)
    metadata = {'scope': 'Synthetic models, identities and grants only; no live database read', 'django': django.get_version(), 'sourceModelsSha256': expected, 'roleMigrationSha256': hashlib.sha256((local / '0005_tenant_administrator.py').read_bytes()).hexdigest(), 'roleModelSha256': hashlib.sha256((local / 'tenant-administrator-model.py').read_bytes()).hexdigest(), 'sqlSha256': hashlib.sha256(sql.encode()).hexdigest(), 'modelMigrationParity': True}
    (out / 'directory-fixture.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata))
