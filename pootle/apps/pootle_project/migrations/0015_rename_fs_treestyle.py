# -*- coding: utf-8 -*-
# Generated by Django 1.10.4 on 2017-01-13 11:07
from __future__ import unicode_literals

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('pootle_project', '0014_just_rename_label_for_choice'),
    ]

    operations = [
        migrations.AlterField(
            model_name='project',
            name='treestyle',
            field=models.CharField(choices=[('auto', 'Automatic detection of gnu/non-gnu file layouts (slower)'), ('gnu', 'GNU style: files named by language code'), ('nongnu', 'Non-GNU: Each language in its own directory'), ('pootle_fs', 'Allow Pootle FS to manage filesystems (Experimental)')], default='auto', max_length=20, verbose_name='Project Tree Style'),
        ),
    ]