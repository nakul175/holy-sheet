from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('directory', '0004_permission_approval')]
    operations = [migrations.CreateModel(
        name='TenantAdministrator',
        fields=[
            ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
            ('application', models.CharField(max_length=30)),
            ('active', models.BooleanField(default=False)),
            ('version', models.PositiveIntegerField(default=1)),
            ('review_reference', models.CharField(max_length=300)),
            ('updated_at', models.DateTimeField(auto_now=True)),
            ('organisation', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='directory.organisation')),
            ('person', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='directory.person')),
        ],
        options={'constraints': [
            models.UniqueConstraint(fields=('organisation', 'person', 'application'), name='tenant_administrator_once'),
            models.CheckConstraint(condition=models.Q(version__gte=1), name='tenant_administrator_version_positive'),
        ]},
    )]
